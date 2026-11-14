import { describe, expect, it } from 'vitest';

import { fetchRange, formatAddress, formatDate, isUserLabel, pickUids, toHexId, toSnippet } from '../src/gmail.ts';

const mailbox = (path: string, flags: string[] = [], specialUse?: string) => ({ path, flags: new Set(flags), specialUse });

describe('isUserLabel', () => {
	it('keeps labels the user made, nested and non-ASCII ones included', () => {
		expect(isUserLabel(mailbox('aposto'))).toBe(true);
		expect(isUserLabel(mailbox('Haberler/Gündem'))).toBe(true);
	});

	it('drops the inbox and Gmail system folders', () => {
		expect(isUserLabel(mailbox('INBOX'))).toBe(false);
		expect(isUserLabel(mailbox('[Gmail]/Sent Mail', [], '\\Sent'))).toBe(false);
		expect(isUserLabel(mailbox('[Gmail]', ['\\Noselect']))).toBe(false);
		expect(isUserLabel(mailbox('[Google Mail]/Spam'))).toBe(false);
	});

	it('drops parents that cannot hold mail', () => {
		expect(isUserLabel(mailbox('Haberler', ['\\Noselect']))).toBe(false);
	});
});

describe('fetchRange', () => {
	it('continues after the cursor', () => {
		expect(fetchRange({ uidValidity: '7', lastUid: 120 }, '7', 200, 50)).toEqual({ from: 121, fullSync: false });
	});

	it('starts over with the newest slots when there is no cursor', () => {
		expect(fetchRange(null, '7', 200, 50)).toEqual({ from: 150, fullSync: true });
	});

	it('starts over when UIDVALIDITY changed', () => {
		expect(fetchRange({ uidValidity: '6', lastUid: 120 }, '7', 200, 50)).toEqual({ from: 150, fullSync: true });
	});

	it('never goes below UID 1', () => {
		expect(fetchRange(null, '7', 10, 50)).toEqual({ from: 1, fullSync: true });
	});
});

describe('pickUids', () => {
	it('drops the newest message that "n:*" returns when nothing is new', () => {
		expect(pickUids([120], 121, 50)).toEqual([]);
	});

	it('takes the oldest first and caps the batch', () => {
		expect(pickUids([125, 121, 123, 122, 124], 121, 3)).toEqual([121, 122, 123]);
	});
});

describe('formatting', () => {
	it('turns decimal IMAP ids into the hex ids Gmail shows', () => {
		expect(toHexId('1278455344230334865')).toBe('11bdfc5cae0c8191');
		expect(toHexId(undefined)).toBe('');
	});

	it('formats senders with and without a display name', () => {
		expect(formatAddress({ name: 'Aposto Gündem', address: 'team@aposto.com' })).toBe('Aposto Gündem <team@aposto.com>');
		expect(formatAddress({ address: 'noreply@medium.com' })).toBe('noreply@medium.com');
		expect(formatAddress(undefined)).toBe('');
	});

	it('formats dates and tolerates unparsed ones', () => {
		expect(formatDate(new Date('2026-11-14T10:00:00Z'))).toBe('Sat, 14 Nov 2026 10:00:00 GMT');
		expect(formatDate('not a date')).toBe('not a date');
		expect(formatDate(new Date('nope'))).toBe('');
	});

	it('collapses whitespace and caps snippets', () => {
		expect(toSnippet('  Merhaba\n\n dünya \t!')).toBe('Merhaba dünya !');
		expect(toSnippet('x'.repeat(500))).toHaveLength(200);
		expect(toSnippet(undefined)).toBe('');
	});
});
