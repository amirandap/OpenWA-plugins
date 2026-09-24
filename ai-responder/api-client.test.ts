import test from 'node:test';
import assert from 'node:assert';
import { fetchChatCompletion } from './api-client.ts';
import type { PluginNetResponse, PluginNetRequestInit } from '../types/openwa';

test('fetchChatCompletion: builds correct request payload and returns text', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: PluginNetRequestInit | undefined;
  
  const mockFetch = async (url: string, init?: PluginNetRequestInit): Promise<PluginNetResponse> => {
    capturedUrl = url;
    capturedInit = init;
    
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {},
      body: JSON.stringify({
        choices: [
          { message: { content: 'Hello from AI' } }
        ]
      })
    };
  };

  const config = {
    apiBaseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-12345',
    model: 'gpt-4o-mini',
    systemPrompt: 'You are a helpful assistant.'
  };

  const reply = await fetchChatCompletion(mockFetch, config, 'Hi');
  
  assert.strictEqual(reply, 'Hello from AI');
  assert.strictEqual(capturedUrl, 'https://api.openai.com/v1/chat/completions');
  
  const bodyParsed = JSON.parse(capturedInit?.body as string);
  assert.strictEqual(bodyParsed.model, 'gpt-4o-mini');
  assert.deepStrictEqual(bodyParsed.messages, [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hi' }
  ]);
  
  assert.strictEqual(capturedInit?.headers?.['Authorization'], 'Bearer sk-12345');
});

test('fetchChatCompletion: throws on non-ok status', async () => {
  const mockFetch = async (): Promise<PluginNetResponse> => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    headers: {},
    body: 'Invalid API key'
  });

  const config = { apiBaseUrl: 'https://api.openai.com/v1', apiKey: 'bad', model: 'gpt-4' };

  await assert.rejects(
    fetchChatCompletion(mockFetch, config, 'Hi'),
    /AI API failed with status 401: Invalid API key/
  );
});

test('fetchChatCompletion: throws on invalid JSON response', async () => {
  const mockFetch = async (): Promise<PluginNetResponse> => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {},
    body: 'NOT JSON'
  });

  const config = { apiBaseUrl: 'https://api.openai.com/v1', apiKey: 'ok', model: 'gpt-4' };

  await assert.rejects(
    fetchChatCompletion(mockFetch, config, 'Hi'),
    /AI API returned invalid JSON/
  );
});

test('fetchChatCompletion: throws on missing choices content', async () => {
  const mockFetch = async (): Promise<PluginNetResponse> => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {},
    body: JSON.stringify({ choices: [] })
  });

  const config = { apiBaseUrl: 'https://api.openai.com/v1', apiKey: 'ok', model: 'gpt-4' };

  await assert.rejects(
    fetchChatCompletion(mockFetch, config, 'Hi'),
    /AI API returned an empty or malformed reply/
  );
});

test('fetchChatCompletion: omits system prompt if undefined or empty', async () => {
  let capturedInit: PluginNetRequestInit | undefined;
  
  const mockFetch = async (url: string, init?: PluginNetRequestInit): Promise<PluginNetResponse> => {
    capturedInit = init;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {},
      body: JSON.stringify({ choices: [{ message: { content: 'Hi' } }] })
    };
  };

  const config = { apiBaseUrl: 'https://api.openai.com/v1', apiKey: 'sk-123', model: 'gpt-4', systemPrompt: '   ' };
  await fetchChatCompletion(mockFetch, config, 'Hi');
  
  const bodyParsed = JSON.parse(capturedInit?.body as string);
  assert.deepStrictEqual(bodyParsed.messages, [
    { role: 'user', content: 'Hi' } // System prompt omitted because it was empty/whitespace
  ]);
});

test('fetchChatCompletion: sends max_tokens and the configured timeout', async () => {
  let capturedInit: PluginNetRequestInit | undefined;
  const mockFetch = async (_url: string, init?: PluginNetRequestInit): Promise<PluginNetResponse> => {
    capturedInit = init;
    return { ok: true, status: 200, statusText: 'OK', headers: {}, body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) };
  };

  const config = { apiBaseUrl: 'https://api.openai.com/v1/', apiKey: 'sk-1', model: 'gpt-4', maxOutputTokens: 123, timeoutMs: 9000 };
  await fetchChatCompletion(mockFetch, config, 'Hi');

  assert.strictEqual(JSON.parse(capturedInit?.body as string).max_tokens, 123);
  assert.strictEqual(capturedInit?.timeoutMs, 9000);
});

test('fetchChatCompletion: an error carries a short slice of the body with the key redacted', async () => {
  const key = 'sk-live-abcdef0123456789';
  const mockFetch = async (): Promise<PluginNetResponse> => ({
    ok: false,
    status: 500,
    statusText: 'Internal Server Error',
    headers: {},
    body: `upstream said: bad key ${key} ${'y'.repeat(5000)}`,
  });

  const config = { apiBaseUrl: 'https://api.openai.com/v1', apiKey: key, model: 'gpt-4' };
  const err = await fetchChatCompletion(mockFetch, config, 'Hi').then(() => null, (e: Error) => e);

  assert.ok(err instanceof Error);
  assert.match(err.message, /status 500: upstream said: bad key \*\*\*/);
  assert.ok(!err.message.includes(key));
  assert.ok(err.message.length < 300, `message is ${err.message.length} chars`);
});
