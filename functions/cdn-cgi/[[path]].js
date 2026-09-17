/** Sink for /cdn-cgi/* analytics — return 204 to not break the page */
export async function onRequest() {
  return new Response(null, { status: 204 });
}
