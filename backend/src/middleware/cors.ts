export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',   // tighten this to your domain later
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
};

export function corsResponse() {
  return {
    statusCode: 200,
    headers: corsHeaders,
    body: '',
  };
}
