export async function onRequest(context) {
    return new Response(JSON.stringify({ message: "Hello from Cloudflare Pages!freellmapi" }), {
        headers: { "Content-Type": "application/json" },
    });
}