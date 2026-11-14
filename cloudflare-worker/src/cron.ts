import { type ChoiceCriteria, type ChoiceQuestion, type Usage, choice, TypeSafeClient } from '@typesafe-ai/sdk';

import { createDb, getHistoryId, setHistoryId } from './db';
import { type Email, type Gmail, type GmailLabel, createGmail } from './google';

// A request holds one state, so judging N emails means N questions that each have to stay
// bound to their own index in that state. The binding decays as the state grows: at 50 per
// request the labels drift toward even odds and stop tracking the sender. Ten measured clean,
// and the chunks still go out concurrently.
const CHUNK_SIZE = 5;

// Emails pulled per fetch.
const BATCH_SIZE = 50;

// Chosen when no label of the user's fits; nothing is written to Gmail for it.
const NO_LABEL = 'none';

// Below this, no label is written: a spread-out distribution means no option won clearly,
// and a wrong label costs more than an unsorted email.
// See https://docs.typesafe.ai/confidence — the boundary scales with the stakes.
const MIN_CONFIDENCE = 0.4;

// USD per million input tokens, per https://docs.typesafe.ai/models. Jev bills input
// tokens only; output tokens are free. A model missing here prices as unknown rather
// than as zero, so a silent model bump cannot understate the bill.
const USD_PER_MTOK_INPUT: Record<string, number> = {
	'jev-1.13.0': 0.042,
};

function costOf(model: string, usage: Usage): number | null {
	const rate = USD_PER_MTOK_INPUT[model];
	return rate === undefined ? null : (usage.input_tokens / 1_000_000) * rate;
}

const formatUsd = (cost: number | null) => (cost === null ? 'unknown' : `$${cost.toFixed(6)}`);

const questionId = (index: number) => `label_${index}`;

// Labels whose name alone does not say what belongs under them. Keyed by the label
// name lowercased, so the key has to match what the label is actually called in Gmail.
const LABEL_DESCRIPTIONS: Record<string, string> = {
	aposto:
		'Any Aposto newsletter, sent from an aposto.com address (usually team@aposto.com). ' +
		'The display name varies per title: "Aposto Gündem", "apéro", "Quando", "Duende", ' +
		'"EXANTE", "Pareto".',
	medium:
		'From noreply@medium.com with the display name "Medium Daily Digest".' +
		'NOT newsletters@medium.com ("The Medium Newsletter", "Medium", "Medium Weekly"), and NOT post, comment, billing ' +
		'or account mail.',
	bytebytego:
		'The ByteByteGo newsletter. It ships through Substack, so the sender is ' + 'bytebytego@substack.com, not a bytebytego.com address.',
};

// A label with no entry above stays undescribed: the user named it, and restating a name
// as its own description only adds tokens.
function buildCriteria(labels: GmailLabel[]): ChoiceCriteria {
	return {
		...Object.fromEntries(labels.map((label) => [label.name, LABEL_DESCRIPTIONS[label.name.toLowerCase()] ?? null])),
		[NO_LABEL]: 'None of the labels above fits this email',
	};
}

type Verdict = { label: string; confidence: number };
type ChunkResult = { verdicts: Verdict[]; cost: number | null };

async function classifyChunk(client: TypeSafeClient, chunk: Email[], criteria: ChoiceCriteria, chunkIndex: number): Promise<ChunkResult> {
	// Question ids never reach the model, so each question names its email by state path.
	const questions: Record<string, ChoiceQuestion> = Object.fromEntries(
		chunk.map((_, index) => [questionId(index), choice(`Which label belongs on the email at \`emails[${index}]\`?`, criteria)]),
	);

	const { answers, model, usage } = await client.systemOne({
		state: { emails: chunk },
		questions,
	});

	const cost = costOf(model, usage);

	// Chunks resolve out of order, so each line names its own chunk.
	console.log(`chunk ${chunkIndex + 1}: ${chunk.length} emails, ${usage.input_tokens} input tokens, ${formatUsd(cost)} (${model})`);

	const verdicts = chunk.map((_, index) => {
		const answer = answers[questionId(index)];
		return { label: answer.choice, confidence: answer.confidence };
	});

	return { verdicts, cost };
}

async function classify(client: TypeSafeClient, emails: Email[], criteria: ChoiceCriteria): Promise<Verdict[]> {
	const chunks: Email[][] = [];
	for (let index = 0; index < emails.length; index += CHUNK_SIZE) {
		chunks.push(emails.slice(index, index + CHUNK_SIZE));
	}

	const results = await Promise.all(chunks.map((chunk, chunkIndex) => classifyChunk(client, chunk, criteria, chunkIndex)));

	const costs = results.map((result) => result.cost);
	const total = costs.some((cost) => cost === null) ? null : costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);

	console.log(`total: ${formatUsd(total)} across ${chunks.length} chunk(s)\n`);

	return results.flatMap((result) => result.verdicts);
}

// + labelled in Gmail, ? held back by the confidence gate, . no label fit.
function mark(labelId: string | undefined, confidence: number): string {
	if (labelId === undefined) return '.';
	return confidence >= MIN_CONFIDENCE ? '+' : '?';
}

export type ProcessedEmail = {
	id: string;
	from: string;
	subject: string;
	label: string;
	confidence: number;
	/** Whether the label was written to Gmail; false when held back or when no label fit. */
	applied: boolean;
};

export type InboxRun = {
	fullSync: boolean;
	emails: ProcessedEmail[];
};

// One pass over a batch: judge it and label what clears the gate.
async function processBatch(
	client: TypeSafeClient,
	gmail: Gmail,
	emails: Email[],
	criteria: ChoiceCriteria,
	labelIds: Map<string, string>,
	labelWidth: number,
): Promise<ProcessedEmail[]> {
	if (emails.length === 0) return [];

	const verdicts = await classify(client, emails, criteria);

	// Grouped by label so each label costs one batchModify call, not one call per email.
	const byLabel = new Map<string, string[]>();

	const processed = emails.map((email, index) => {
		const { label, confidence } = verdicts[index];
		const labelId = labelIds.get(label);
		const applied = labelId !== undefined && confidence >= MIN_CONFIDENCE;

		if (applied) byLabel.set(labelId, [...(byLabel.get(labelId) ?? []), email.id]);

		console.log(`${mark(labelId, confidence)} ${label.padEnd(labelWidth)} (${confidence.toFixed(2)}) ${email.from} — ${email.subject}`);

		return { id: email.id, from: email.from, subject: email.subject, label, confidence, applied };
	});

	await Promise.all([...byLabel].map(([labelId, ids]) => gmail.applyLabel(ids, labelId)));

	const applied = processed.filter((email) => email.applied).length;
	const heldBack = processed.filter((email) => !email.applied && labelIds.has(email.label)).length;

	console.log(
		`\n${applied} labelled, ${heldBack} held back under ${MIN_CONFIDENCE} confidence, ` +
			`${emails.length - applied - heldBack} with no matching label.\n`,
	);

	return processed;
}

export async function processInbox(env: Env): Promise<InboxRun> {
	const db = createDb(env);
	// The SDK looks for TYPESAFE_API_KEY; this worker's secret is named TYPESAFE_AI_API_KEY.
	const client = new TypeSafeClient({ apiKey: env.TYPESAFE_AI_API_KEY });
	const gmail = createGmail(env);

	const labels = await gmail.listUserLabels();

	if (labels.length === 0) {
		throw new Error('This mailbox has no user-created Gmail labels, so there is nothing to sort into.');
	}

	const criteria = buildCriteria(labels);
	const labelIds = new Map(labels.map((label) => [label.name, label.id]));
	const labelWidth = Math.max(...Object.keys(criteria).map((label) => label.length));

	// One batch per run keeps the whole run inside the Free plan's 50 subrequests; a backlog
	// bigger than that drains over the following runs.
	const { emails, historyId, fullSync } = await gmail.getNewEmails(BATCH_SIZE, await getHistoryId(db));

	console.log(`${fullSync ? 'full sync' : 'incremental'}: ${emails.length} email(s) to judge.\n`);

	const processed = await processBatch(client, gmail, emails, criteria, labelIds, labelWidth);

	// Only now: a crash above leaves the anchor where it was, and the next run retries.
	if (historyId) await setHistoryId(db, historyId);

	return { fullSync, emails: processed };
}
