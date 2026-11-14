// Gmail over plain REST: googleapis and google-auth-library lean on Node's fs/http and
// weigh far more than a Worker needs for a handful of endpoints.
//
// Every fetch here (and every D1 call) is a subrequest, and the Workers Free plan allows 50 per
// invocation. So details come back through one batch call and labels go out through
// batchModify, one call per label, rather than one call per email.
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GMAIL_BATCH = 'https://gmail.googleapis.com/batch/gmail/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const HEADERS = ['From', 'Subject', 'Date'];

// Kept low: each retry is another subrequest out of the same 50.
const MAX_RETRIES = 2;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export type GmailLabel = {
	id: string;
	name: string;
};

export type Email = {
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
	historyId: string | null;
	fullSync: boolean;
};

type Header = { name?: string; value?: string };

type Label = { id?: string; name?: string; type?: string };

type Message = {
	id?: string;
	threadId?: string;
	labelIds?: string[];
	snippet?: string;
	payload?: { headers?: Header[] };
};

type MessageList = { messages?: Message[] };

type HistoryList = {
	history?: { id?: string; messagesAdded?: { message?: Message }[] }[];
	historyId?: string;
	nextPageToken?: string;
};

type Profile = { historyId?: string };

type BatchPart = { status: number; body: string };

export class GmailError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

// The refresh token is minted once, outside the Worker, with the gmail.modify scope; each
// run trades it for an hour-long access token, which outlives any single cron run.
async function fetchAccessToken(env: Env): Promise<string> {
	const response = await fetch(TOKEN_URL, {
		method: 'POST',
		body: new URLSearchParams({
			client_id: env.GOOGLE_CLIENT_ID,
			client_secret: env.GOOGLE_CLIENT_SECRET,
			refresh_token: env.GOOGLE_REFRESH_TOKEN,
			grant_type: 'refresh_token',
		}),
	});

	if (!response.ok) {
		const body = await response.text();

		// While the OAuth app sits in "Testing", Google expires its refresh tokens after 7 days
		// and every run fails here until a new one is minted and stored.
		if (body.includes('invalid_grant')) {
			throw new Error(
				'GOOGLE_REFRESH_TOKEN expired or was revoked (invalid_grant). Re-run the consent flow ' +
					'and store the new token with `wrangler secret put GOOGLE_REFRESH_TOKEN`.',
			);
		}

		throw new Error(`Google token refresh failed: ${response.status} ${body}`);
	}

	const { access_token } = await response.json<{ access_token: string }>();
	return access_token;
}

function backoff(attempt: number, retryAfter: string | null): number {
	const seconds = Number(retryAfter);
	return seconds > 0 ? seconds * 1000 : 2 ** attempt * 1000 + Math.random() * 500;
}

function readHeader(headers: Header[], name: string): string {
	const header = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
	return header?.value ?? '';
}

// Each part of a multipart/mixed batch response wraps a whole HTTP response: part headers,
// a blank line, the status line and headers of the inner response, a blank line, its body.
function parseBatchResponse(body: string, boundary: string): BatchPart[] {
	return body
		.split(`--${boundary}`)
		.slice(1, -1)
		.map((part) => {
			const inner = part.split(/\r?\n\r?\n/);
			const status = Number(/HTTP\/[\d.]+ (\d{3})/.exec(inner[1] ?? '')?.[1] ?? 0);
			return { status, body: inner.slice(2).join('\n\n').trim() };
		});
}

// Gmail drops history records after a week or so; a cursor older than that comes back
// as a 404 rather than an empty page, and the only recovery is a full sync.
function isStaleCursor(error: unknown): boolean {
	return error instanceof GmailError && error.status === 404;
}

export function createGmail(env: Env) {
	let accessToken: Promise<string> | null = null;
	let labels: Promise<Label[]> | null = null;

	function authorization(): Promise<string> {
		accessToken ??= fetchAccessToken(env);
		return accessToken.then((token) => `Bearer ${token}`);
	}

	async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
		for (let attempt = 0; ; attempt += 1) {
			const response = await fetch(`${GMAIL_API}${path}`, {
				...init,
				headers: { ...init.headers, Authorization: await authorization() },
			});

			// batchModify answers 204 with no body.
			const body = await response.text();
			if (response.ok) return (body ? JSON.parse(body) : undefined) as T;

			// Gmail meters each user at 250 quota units a second and answers bursts with 429 (or a
			// passing 5xx); backing off and retrying is what its docs prescribe.
			if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
				const delay = backoff(attempt, response.headers.get('Retry-After'));
				console.warn(`Gmail ${path} returned ${response.status}; retrying in ${Math.round(delay)}ms`);
				await scheduler.wait(delay);
				continue;
			}

			throw new GmailError(response.status, `Gmail ${path} failed: ${response.status} ${body}`);
		}
	}

	// Fetched once per run: both the label choices and the names on each email come from it.
	function fetchLabels(): Promise<Label[]> {
		labels ??= request<{ labels?: Label[] }>('/labels').then((data) => data.labels ?? []);
		return labels;
	}

	// The labels the user made themselves; Gmail's own (INBOX, SPAM, CATEGORY_*) are
	// type "system" and are not choices a human would sort mail into.
	async function listUserLabels(): Promise<GmailLabel[]> {
		return (await fetchLabels())
			.filter((label) => label.type === 'user' && label.id != null)
			.map((label) => ({ id: label.id!, name: label.name ?? label.id! }));
	}

	// One call for any number of emails (up to Gmail's 1000) going under the same label.
	async function applyLabel(emailIds: string[], labelId: string): Promise<void> {
		if (emailIds.length === 0) return;

		await request('/messages/batchModify', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ids: emailIds, addLabelIds: [labelId] }),
		});
	}

	async function getProfileHistoryId(): Promise<string | null> {
		const { historyId } = await request<Profile>('/profile');
		return historyId ?? null;
	}

	// Only messageAdded: the labelsAdded records that applyLabel itself writes would
	// otherwise come straight back as work.
	async function listAddedInboxIds(
		startHistoryId: string,
		maxResults: number,
	): Promise<{ ids: string[]; historyId: string | null } | null> {
		const ids: string[] = [];
		const seen = new Set<string>();
		let historyId: string | null = null;
		let pageToken: string | undefined;

		do {
			const params = new URLSearchParams({ startHistoryId, historyTypes: 'messageAdded', labelId: 'INBOX' });
			if (pageToken) params.set('pageToken', pageToken);

			let data: HistoryList;

			try {
				data = await request<HistoryList>(`/history?${params}`);
			} catch (error) {
				if (isStaleCursor(error)) return null;
				throw error;
			}

			historyId = data.historyId ?? historyId;

			for (const record of data.history ?? []) {
				for (const added of record.messagesAdded ?? []) {
					const id = added.message?.id;
					if (id == null || seen.has(id)) continue;

					seen.add(id);
					ids.push(id);
				}

				// More change log than one run can take: stop on a record boundary and anchor at that
				// record, so the next run starts right after it instead of replaying this batch.
				if (ids.length >= maxResults && record.id) return { ids, historyId: record.id };
			}

			pageToken = data.nextPageToken;
		} while (pageToken);

		return { ids, historyId };
	}

	// All the metadata gets in one batch request, which is one subrequest however many emails it
	// holds. Gmail still meters the parts one by one, so parts refused with 429 go round again.
	async function fetchDetails(ids: string[]): Promise<Email[]> {
		if (ids.length === 0) return [];

		const labelNames = new Map(
			(await fetchLabels()).filter((label) => label.id != null).map((label) => [label.id!, label.name ?? label.id!]),
		);

		const params = new URLSearchParams({ format: 'metadata' });
		for (const header of HEADERS) params.append('metadataHeaders', header);

		const details = new Map<string, Message>();
		let pending = ids;

		for (let attempt = 0; pending.length > 0; attempt += 1) {
			const boundary = `batch_${crypto.randomUUID()}`;
			const body =
				pending
					.map(
						(id, index) =>
							`--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <${index}>\r\n\r\n` +
							`GET /gmail/v1/users/me/messages/${id}?${params}\r\n\r\n`,
					)
					.join('') + `--${boundary}--\r\n`;

			const response = await fetch(GMAIL_BATCH, {
				method: 'POST',
				headers: { Authorization: await authorization(), 'Content-Type': `multipart/mixed; boundary=${boundary}` },
				body,
			});

			const text = await response.text();
			if (!response.ok) throw new GmailError(response.status, `Gmail batch failed: ${response.status} ${text}`);

			const responseBoundary = /boundary=([^;]+)/.exec(response.headers.get('Content-Type') ?? '')?.[1];
			if (!responseBoundary) throw new Error('Gmail batch response carried no multipart boundary');

			// Parts come back in request order.
			const parts = parseBatchResponse(text, responseBoundary.replace(/"/g, ''));
			const retry: string[] = [];

			for (const [index, id] of pending.entries()) {
				const part = parts[index];

				if (part?.status === 200) {
					details.set(id, JSON.parse(part.body));
				} else if ((part === undefined || RETRYABLE_STATUSES.has(part.status)) && attempt < MAX_RETRIES) {
					retry.push(id);
				} else {
					throw new GmailError(part?.status ?? 0, `Gmail message ${id} failed: ${part?.status} ${part?.body}`);
				}
			}

			if (retry.length > 0) {
				const delay = backoff(attempt, null);
				console.warn(`Gmail batch: ${retry.length} part(s) throttled; retrying in ${Math.round(delay)}ms`);
				await scheduler.wait(delay);
			}

			pending = retry;
		}

		return ids.map((id) => {
			const detail = details.get(id)!;
			const headers = detail.payload?.headers ?? [];

			return {
				id: detail.id ?? id,
				threadId: detail.threadId ?? '',
				from: readHeader(headers, 'From'),
				subject: readHeader(headers, 'Subject'),
				date: readHeader(headers, 'Date'),
				snippet: detail.snippet ?? '',
				labels: (detail.labelIds ?? []).map((labelId) => labelNames.get(labelId) ?? labelId),
			};
		});
	}

	// Emails that arrived since `startHistoryId`, at most about `maxResults` of them. With no
	// cursor, or one Gmail has expired, it takes the newest `maxResults` in the inbox and anchors
	// at where the mailbox stood before listing; the older backlog is not walked.
	async function getNewEmails(maxResults: number, startHistoryId: string | null): Promise<MailboxFetch> {
		const changes = startHistoryId ? await listAddedInboxIds(startHistoryId, maxResults) : null;

		if (changes) {
			return { emails: await fetchDetails(changes.ids), historyId: changes.historyId, fullSync: false };
		}

		// Read the cursor before listing, so mail landing mid-run is seen again next run
		// rather than skipped.
		const historyId = await getProfileHistoryId();

		const params = new URLSearchParams({ labelIds: 'INBOX', maxResults: String(maxResults) });
		const { messages } = await request<MessageList>(`/messages?${params}`);
		const ids = (messages ?? []).flatMap((message) => (message.id == null ? [] : [message.id]));

		return { emails: await fetchDetails(ids), historyId, fullSync: true };
	}

	return { listUserLabels, applyLabel, getNewEmails };
}

export type Gmail = ReturnType<typeof createGmail>;
