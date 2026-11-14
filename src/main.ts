import { loadConfig } from './config.ts';
import { processInbox } from './labeller.ts';

function describe(error: unknown): string {
	// imapflow marks a rejected LOGIN this way.
	if ((error as { authenticationFailed?: boolean }).authenticationFailed) {
		return (
			'Gmail rejected GMAIL_USER / GMAIL_APP_PASSWORD. App passwords are revoked when the Google ' +
			'account password changes and need 2-Step Verification to stay on; create a new one at ' +
			'https://myaccount.google.com/apppasswords and put it in .env.'
		);
	}

	return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

console.log(`Run started at ${new Date().toISOString()}`);

try {
	await processInbox(loadConfig());
} catch (error) {
	console.error(`Run failed: ${describe(error)}`);
	process.exitCode = 1;
}
