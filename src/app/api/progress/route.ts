import { NextRequest } from "next/server";

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get('jobId') || 'unknown';

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      function send(data: unknown) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      }
      send({ jobId, stage: 'uploaded', progress: 10 });
      await new Promise(r => setTimeout(r, 500));
      send({ jobId, stage: 'queued', progress: 20 });
      await new Promise(r => setTimeout(r, 500));
      send({ jobId, stage: 'processing', progress: 70 });
      await new Promise(r => setTimeout(r, 500));
      send({ jobId, stage: 'done', progress: 100 });
      controller.close();
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
