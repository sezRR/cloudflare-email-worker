import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Where the last run left off in the inbox. UIDs only mean something under the UIDVALIDITY
// they were issued with, so the two travel together.
export type Cursor = {
	uidValidity: string;
	lastUid: number;
};

type StateFile = { cursor?: string };

export function formatCursor(cursor: Cursor): string {
	return `${cursor.uidValidity}:${cursor.lastUid}`;
}

export function parseCursor(value: string | null | undefined): Cursor | null {
	const match = /^(\d+):(\d+)$/.exec(value ?? '');
	return match ? { uidValidity: match[1], lastUid: Number(match[2]) } : null;
}

export async function readCursor(path: string): Promise<Cursor | null> {
	let raw: string;

	try {
		raw = await readFile(path, 'utf8');
	} catch (error) {
		// No file yet is the first run, not a failure.
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}

	return parseCursor((JSON.parse(raw) as StateFile).cursor);
}

// Written beside the target and renamed over it, so a crash mid-write leaves the old cursor
// in place rather than a truncated file.
export async function writeCursor(path: string, cursor: Cursor): Promise<void> {
	await mkdir(dirname(path), { recursive: true });

	const temporary = `${path}.tmp`;
	const state: StateFile = { cursor: formatCursor(cursor) };

	await writeFile(temporary, `${JSON.stringify(state)}\n`);
	await rename(temporary, path);
}
