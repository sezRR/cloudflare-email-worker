import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.ts';
import { formatCursor, parseCursor, readCursor, writeCursor } from '../src/state.ts';

describe('cursor', () => {
	it('round-trips through its text form', () => {
		const cursor = { uidValidity: '1700000000', lastUid: 4821 };
		expect(parseCursor(formatCursor(cursor))).toEqual(cursor);
	});

	it('rejects anything that is not "<uidValidity>:<uid>"', () => {
		expect(parseCursor(null)).toBeNull();
		expect(parseCursor('')).toBeNull();
		expect(parseCursor('12345')).toBeNull();
		expect(parseCursor('a:b')).toBeNull();
	});

	it('reads nothing before the first run, then what was written', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'labeller-'));
		const path = join(dir, 'nested', 'state.json');

		try {
			expect(await readCursor(path)).toBeNull();

			await writeCursor(path, { uidValidity: '7', lastUid: 9 });
			await writeCursor(path, { uidValidity: '7', lastUid: 12 });

			expect(await readCursor(path)).toEqual({ uidValidity: '7', lastUid: 12 });
			expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ cursor: '7:12' });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe('loadConfig', () => {
	const env = { GMAIL_USER: 'me@example.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop', TYPESAFE_AI_API_KEY: 'key' };

	it('strips the spaces Google shows in app passwords and defaults the state path', () => {
		expect(loadConfig(env)).toEqual({
			gmailUser: 'me@example.com',
			gmailAppPassword: 'abcdefghijklmnop',
			typesafeApiKey: 'key',
			statePath: '/data/state.json',
		});
	});

	it('names the variable that is missing', () => {
		expect(() => loadConfig({ ...env, GMAIL_APP_PASSWORD: ' ' })).toThrow('GMAIL_APP_PASSWORD');
	});
});
