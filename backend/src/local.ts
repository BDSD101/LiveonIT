import { handler } from './functions/api';

const event = {
	httpMethod: process.env.METHOD || 'GET',
	path: process.env.PATH_OVERRIDE || '/health',
	headers: {},
	queryStringParameters: process.env.QUERY 
		? JSON.parse(process.env.QUERY) 
		: null,
		body: process.env.BODY || null,
} as any;

async function run() {
	require('dotenv').config();
	const result = await handler(event);
	console.log('Status:', result.statusCode);
	console.log('Body:', JSON.parse(result.body as string));
}

run().catch(console.error);
