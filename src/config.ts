export type Config = {
	gmailUser: string;
	gmailAppPassword: string;
	typesafeApiKey: string;
	statePath: string;
};

const DEFAULT_STATE_PATH = '/data/state.json';

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name]?.trim();
	if (!value) throw new Error(`Missing required environment variable ${name}.`);
	return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	return {
		gmailUser: required(env, 'GMAIL_USER'),
		// Google shows app passwords in four space-separated groups; the spaces are not part of it.
		gmailAppPassword: required(env, 'GMAIL_APP_PASSWORD').replace(/\s+/g, ''),
		typesafeApiKey: required(env, 'TYPESAFE_AI_API_KEY'),
		statePath: env.STATE_PATH?.trim() || DEFAULT_STATE_PATH,
	};
}
