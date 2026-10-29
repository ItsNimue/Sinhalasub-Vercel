import app from '../index.js';

// Vercel (Node.js runtime) එකෙන් request body එක කියවගන්නේ අපිම,
// ඒ නිසා Vercel ගේ auto body-parsing එක off කරනවා.
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
    try {
        await app.ready();

        // request body එකක් තියෙනවා නම් (මේ API එකේ GET routes විතරයි, ඒත් future-proof කරනවා)
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const payload = chunks.length ? Buffer.concat(chunks) : undefined;

        // fastify.listen() කරන්නේ නැතුව, fastify ගේම router එකට කෙළින්ම request එක දෙනවා
        const response = await app.inject({
            method: req.method,
            url: req.url,
            headers: req.headers,
            payload
        });

        res.statusCode = response.statusCode;

        for (const [key, value] of Object.entries(response.headers)) {
            if (value !== undefined) res.setHeader(key, value);
        }

        res.end(response.rawPayload);
    } catch (err) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: false, error: err.message }));
    }
}
