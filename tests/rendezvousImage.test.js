import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RendezvousImageService,
  scaffoldDrawingPrompt
} from '../server/rendezvous/rendezvousImage.js';

test('image scaffolding preserves a sender-authored visual language without text', () => {
  const prompt = scaffoldDrawingPrompt(
    'A charcoal skyline reflected in three puddles like three possible futures.',
    ['three shallow curbside puddles', 'a narrow tower reflected in them']
  );
  assert.match(prompt, /Sender's drawing instructions/);
  assert.match(prompt, /three possible futures/);
  assert.match(prompt, /no readable words, letters, numbers/);
  assert.match(prompt, /Visual anchors available/);
  assert.match(prompt, /symbolic, diagrammatic, map-like/);
  assert.match(prompt, /Arrows, paths, motion/);
});

test('image scaffolding permits a sender-authored symbolic route message', () => {
  const prompt = scaffoldDrawingPrompt(
    'A blue arrow bends toward two circles that nearly meet.',
    []
  );
  assert.match(prompt, /blue arrow/);
  assert.match(prompt, /None specified/);
});

test('image service generates from the sender prompt without Street View attachments', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  let request;
  try {
    const service = new RendezvousImageService({
      fetchImpl: async (url, options) => {
        request = { url, options };
        return {
          ok: true,
          headers: { get: name => name === 'x-request-id' ? 'req-1' : null },
          async json() {
            return { data: [{ b64_json: Buffer.from('raster').toString('base64') }] };
          }
        };
      },
      logger: { warn() {} }
    });
    const result = await service.generate({
      drawingPrompt: 'A loose pencil arch enclosing two circles that nearly touch.',
      groundedFeatures: ['a broad stone arch', 'two globe lamps beside it']
    });
    assert.match(request.url, /\/images\/generations$/);
    const body = JSON.parse(request.options.body);
    assert.equal(body.model, 'gpt-image-2');
    assert.equal(body.size, '1152x768');
    assert.match(body.prompt, /two circles that nearly touch/);
    assert.match(body.prompt, /two globe lamps/);
    assert.doesNotMatch(request.options.body, /image\[\]|reference/);
    assert.equal(result.buffer.toString(), 'raster');
    assert.equal(result.requestId, 'req-1');
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('image service grounds an authored sketch through one private source image', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  let request;
  try {
    const service = new RendezvousImageService({
      fetchImpl: async (url, options) => {
        request = { url, options };
        return {
          ok: true,
          headers: { get: () => null },
          async json() {
            return { data: [{ b64_json: Buffer.from('grounded-raster').toString('base64') }] };
          }
        };
      },
      logger: { warn() {} }
    });
    await service.generate({
      drawingPrompt: 'Sketch the actual railing as a sparse landmark.',
      groundedFeatures: ['a plain metal railing beside open water'],
      referenceImage: {
        buffer: Buffer.from('private-source-view'),
        mimeType: 'image/jpeg'
      }
    });

    assert.match(request.url, /\/images\/edits$/);
    assert.ok(request.options.body instanceof FormData);
    assert.equal(request.options.headers['Content-Type'], undefined);
    assert.equal(request.options.body.get('model'), 'gpt-image-2');
    assert.equal(request.options.body.get('image[]').type, 'image/jpeg');
    assert.match(
      request.options.body.get('prompt'),
      /do not replace a real object's geometry with a generic decorative version/i
    );
    assert.match(request.options.body.get('prompt'), /Do not copy the photograph as a scene/i);
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});
