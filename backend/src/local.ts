import 'dotenv/config';
import { handler } from './functions/api';

// console.log('DB_HOST:', process.env.DB_HOST);
// console.log('DB_PORT:', process.env.DB_PORT);
// console.log('DB_NAME:', process.env.DB_NAME);
// console.log('DB_USER:', process.env.DB_USER);
// console.log('DB_PASSWORD:', process.env.DB_PASSWORD);
// console.log('DB_SSL:', process.env.DB_SSL);
// console.log('NODE_ENV:', process.env.NODE_ENV);

const event = {
	httpMethod: process.env.METHOD || 'GET',
	path: process.env.PATH_OVERRIDE || '/health',
	headers: {},
	queryStringParameters: process.env.QUERY 
		? JSON.parse(process.env.QUERY) 
		: null,
		body: process.env.BODY || null,
} as any;

// async function run() {
// 	// require('dotenv').config(); // imported at the top to ensure it's loaded before accessing environment variables
// 	const result = await handler(event);
// 	console.log('Status:', result.statusCode);
// 	console.log('Body:', JSON.parse(result.body as string));
// 	// console.log('DB_HOST:', process.env.DB_HOST);
// 	// console.log('DB_PORT:', process.env.DB_PORT);
// 	// console.log('DB_NAME:', process.env.DB_NAME);
// 	// console.log('DB_USER:', process.env.DB_USER);
// 	// console.log('DB_PASSWORD:', process.env.DB_PASSWORD);
// 	// console.log('DB_SSL:', process.env.DB_SSL);
// 	// console.log('NODE_ENV:', process.env.NODE_ENV);
// }

// // run().catch(console.error);
// run().catch((err) => {
// 	console.error('Error:', err.message);
// });

async function run() {
  const result = await handler(event);
  console.log('Status:', result.statusCode);
  console.log('Raw body:', result.body);
  try {
    console.log('Body:', JSON.parse(result.body as string));
  } catch (e) {
    console.log('Could not parse body');
  }
}

run().catch((err) => {
  console.error('Full error:', err);
  console.error('Message:', err.message);
  console.error('Code:', err.code);
  console.error('Stack:', err.stack);
});