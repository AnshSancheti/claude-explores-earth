import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RendezvousImageService,
  scaffoldDrawingPrompt
} from '../server/rendezvous/rendezvousImage.js';

test('image scaffolding constrains the medium without authoring the clue', () => {
  const prompt = scaffoldDrawingPrompt(
    'A charcoal skyline reflected in three puddles like three possible futures.',
    ['three shallow curbside puddles', 'a narrow tower reflected in them']
  );
  assert.match(prompt, /Sender's drawing instructions/);
  assert.match(prompt, /three possible futures/);
  assert.match(prompt, /no readable words, letters, numbers/);
  assert.match(prompt, /stable visible features/);
  assert.match(prompt, /not become a literal camera reproduction/);
  assert.match(prompt, /not become.*purely decorative abstraction/);
  assert.match(prompt, /never exaggerate a vanishing point into a directional cue/);
  assert.match(prompt, /postcard about what the sender sees/);
  assert.doesNotMatch(prompt, /Manhattan|north|south|find Theo/);
});

test('image scaffolding refuses an ungrounded route diagram', () => {
  assert.throws(
    () => scaffoldDrawingPrompt('A blue arrow pointing forward.', ['one road']),
    /two grounded visible features/
  );
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
