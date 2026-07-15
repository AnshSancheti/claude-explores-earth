import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RendezvousImageService,
  scaffoldDrawingPrompt
} from '../server/rendezvous/rendezvousImage.js';

test('image scaffolding constrains the medium without authoring the clue', () => {
  const prompt = scaffoldDrawingPrompt('A charcoal skyline reflected in three puddles.');
  assert.match(prompt, /Sender's drawing instructions/);
  assert.match(prompt, /charcoal skyline reflected in three puddles/);
  assert.match(prompt, /no readable words, letters, numbers/);
  assert.doesNotMatch(prompt, /Manhattan|north|south|find Theo/);
});

test('image service sends references to the edit endpoint and returns raster bytes', async () => {
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
      drawingPrompt: 'A loose pencil drawing of an arch.',
      referenceImages: [Buffer.from([0xff, 0xd8, 0xff])]
    });
    assert.match(request.url, /\/images\/edits$/);
    assert.equal(request.options.body.get('model'), 'gpt-image-2');
    assert.equal(request.options.body.get('size'), '1152x768');
    assert.match(request.options.body.get('prompt'), /loose pencil drawing of an arch/);
    assert.equal(result.buffer.toString(), 'raster');
    assert.equal(result.requestId, 'req-1');
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});
