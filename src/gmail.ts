// Gmail over IMAP, signed in with an app password. App passwords do not work against the
// Gmail REST API, and unlike the refresh token of an OAuth app left in "Testing" they do not
// expire after a week.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

import type { Config } from './config.ts';
import type { Cursor } from './state.ts';

const HOST = 'imap.gmail.com';
const PORT = 993;

// How much of each message is downloaded to build its snippet. Headers alone (DKIM, ARC,
// Received chains) often run past 10 kB, so this leaves room for some body after them.
const SOURCE_BYTES = 32 * 1024;
const SNIPPET_LENGTH = 200;

export type GmailLabel = {
	/** The label's IMAP path, which is what gets written back to Gmail. */
	id: string;
	name: string;
};

export type Email = {
	/** UID within the inbox; what labels are applied by. */
	uid: number;
	id: string;
	threadId: string;
	from: string;
	subject: string;
	date: string;
	snippet: string;
	labels: string[];
};

export type MailboxFetch = {
	emails: Email[];
	/** Cursor to store once the emails are handled. */
	cursor: Cursor;
	fullSync: boolean;
};

export type MailboxEntry = {
	path: string;
	flags: Set<string>;
	specialUse?: string | undefined;
};

type Address = { name?: string | undefined; address?: string | undefined };

// The labels the user made themselves. Gmail's own folders sit under "[Gmail]" (or
// "[Google Mail]") and carry a special-use flag; neither they nor the inbox are choices a
// human would sort mail into. \Noselect entries are parents that exist only to hold children.
export function isUserLabel(mailbox: MailboxEntry): boolean {
	if (mailbox.path.toUpperCase() === 'INBOX') return false;
	if (/^\[(Gmail|Google Mail)\]/i.test(mailbox.path)) return false;
	if (mailbox.specialUse) return false;
	return !mailbox.flags.has('\\Noselect');
}

// Which UIDs to ask the server for. With no cursor, or one issued under another UIDVALIDITY,
// it is the newest `max` slots of the inbox; the older backlog is not walked.
export function fetchRange(cursor: Cursor | null, uidValidity: string, uidNext: number, max: number): { from: number; fullSync: boolean } {
	if (cursor && cursor.uidValidity === uidValidity) return { from: cursor.lastUid + 1, fullSync: false };
	return { from: Math.max(1, uidNext - max), fullSync: true };
}

// "n:*" always answers with the newest message, even when its UID is below n, so anything
// under `from` is dropped. Oldest first, capped: a backlog drains over the following runs.
export function pickUids(uids: number[], from: number, max: number): number[] {
	return uids
		.filter((uid) => uid >= from)
		.sort((a, b) => a - b)
		.slice(0, max);
}

// Gmail's IMAP ids are the decimal form of the hex ids its web interface and REST API use.
export function toHexId(id: string | undefined): string {
	if (!id) return '';

	try {
		return BigInt(id).toString(16);
	} catch {
		return id;
	}
}

export function formatAddress(address: Address | undefined): string {
	if (!address) return '';
	if (!address.name) return address.address ?? '';
	return address.address ? `${address.name} <${address.address}>` : address.name;
}

// The server hands the envelope date over as a Date when it parses and as the raw text when
// it does not.
export function formatDate(date: Date | string | undefined): string {
	if (date instanceof Date) return Number.isNaN(date.getTime()) ? '' : date.toUTCString();
	return date ?? '';
}

export function toSnippet(text: string | undefined): string {
	return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LENGTH);
}

// Best effort: the source is cut off at SOURCE_BYTES, so a body can end mid-part. Whatever
// text survives is still more than no snippet at all.
async function snippetOf(source: Buffer | undefined): Promise<string> {
	if (!source) return '';

	try {
		const parsed = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true });
		return toSnippet(parsed.text);
	} catch {
		return '';
	}
}

export function createGmail(config: Config) {
	const client = new ImapFlow({
		host: HOST,
		port: PORT,
		secure: true,
		auth: { user: config.gmailUser, pass: config.gmailAppPassword },
		logger: false,
	});

	// Without a listener a dropped connection is an unhandled 'error' event and kills the
	// process; the command that was in flight rejects on its own and carries the reason.
	client.on('error', (error: Error) => console.error(`IMAP connection error: ${error.message}`));

	let inbox: Promise<{ uidValidity: string; uidNext: number }> | null = null;

	// One connection per run, opened on first use.
	function openInbox() {
		inbox ??= (async () => {
			await client.connect();
			const mailbox = await client.mailboxOpen('INBOX');
			return { uidValidity: String(mailbox.uidValidity), uidNext: mailbox.uidNext };
		})();

		return inbox;
	}

	async function listUserLabels(): Promise<GmailLabel[]> {
		await openInbox();
		return (await client.list()).filter(isUserLabel).map((mailbox) => ({ id: mailbox.path, name: mailbox.path }));
	}

	// One STORE for any number of emails going under the same label. It adds the label and
	// leaves everything else, the inbox included, as it was.
	async function applyLabel(uids: number[], labelId: string): Promise<void> {
		if (uids.length === 0) return;

		await openInbox();
		const stored = await client.messageFlagsAdd(uids.join(','), [labelId], { uid: true, useLabels: true });
		if (!stored) throw new Error(`Gmail refused to add label "${labelId}" to ${uids.length} email(s).`);
	}

	// Emails that arrived after the cursor, at most `max` of them, oldest first.
	async function getNewEmails(max: number, cursor: Cursor | null): Promise<MailboxFetch> {
		const { uidValidity, uidNext } = await openInbox();
		const { from, fullSync } = fetchRange(cursor, uidValidity, uidNext, max);

		// UIDs first, bodies second: after a long outage the range can hold far more mail than
		// one run takes, and only the chosen ones are worth downloading.
		const found = uidNext > from ? await client.search({ uid: `${from}:*` }, { uid: true }) : [];
		const uids = pickUids(found || [], from, max);

		const emails: Email[] = [];

		if (uids.length > 0) {
			const messages = await client.fetchAll(
				uids.join(','),
				// The source is fetched with BODY.PEEK, so reading it does not mark the mail as read.
				{ uid: true, envelope: true, labels: true, threadId: true, source: { start: 0, maxLength: SOURCE_BYTES } },
				{ uid: true },
			);

			messages.sort((a, b) => a.uid - b.uid);

			for (const message of messages) {
				emails.push({
					uid: message.uid,
					id: toHexId(message.emailId),
					threadId: toHexId(message.threadId),
					from: formatAddress(message.envelope?.from?.[0]),
					subject: message.envelope?.subject ?? '',
					date: formatDate(message.envelope?.date),
					snippet: await snippetOf(message.source),
					labels: [...(message.labels ?? [])],
				});
			}
		}

		// Capped or not, the next run starts right after the newest email handed out here. With
		// nothing new, a full sync still anchors at where the inbox stands.
		const lastUid = emails.at(-1)?.uid ?? (fullSync ? uidNext - 1 : cursor!.lastUid);

		return { emails, cursor: { uidValidity, lastUid }, fullSync };
	}

	async function close(): Promise<void> {
		if (!inbox) return;

		try {
			await client.logout();
		} catch {
			client.close();
		}
	}

	return { listUserLabels, applyLabel, getNewEmails, close };
}

export type Gmail = ReturnType<typeof createGmail>;
