// Recording Bot API double. Every `api.<method>(params)` call is recorded in
// `api.calls`; results come from scripted handlers (`api.on`) or defaults.
// Failures are thrown as FakeBotApiError, shaped like the SDK's BotApiError.

export class FakeBotApiError extends Error {
  constructor(method, code, description, parameters = undefined) {
    super(description);
    this.name = 'BotApiError';
    this.method = method;
    this.code = code;
    this.description = description;
    this.parameters = parameters;
  }
}

export const BOT = { id: 4242, is_bot: true, first_name: 'Test Bot', username: 'test_bot' };

export function createFakeApi() {
  let nextMessageId = 1000;
  const handlers = new Map();
  const calls = [];

  const defaults = {
    getMe: () => BOT,
    sendMessage: (p) => ({ message_id: nextMessageId++, chat: { id: p.chat_id }, text: p.text }),
    editMessageText: () => true,
    editMessageReplyMarkup: () => true,
    answerCallbackQuery: () => true,
    copyMessages: (p) => p.message_ids.map(() => ({ message_id: nextMessageId++ })),
  };

  const control = {
    calls,
    /** Script a method: fn(params, nthCallOfThisMethod) returns a result or throws. */
    on(method, fn) {
      handlers.set(method, fn);
      return api;
    },
    fail(method, code, description, parameters) {
      return control.on(method, () => {
        throw new FakeBotApiError(method, code, description, parameters);
      });
    },
    callsOf(method) {
      return calls.filter((c) => c.method === method).map((c) => c.params);
    },
    reset() {
      calls.length = 0;
    },
  };

  const api = new Proxy(control, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return async (params = {}) => {
        const n = calls.filter((c) => c.method === prop).length;
        calls.push({ method: prop, params });
        await new Promise((resolve) => setImmediate(resolve));
        const fn = handlers.get(prop) ?? defaults[prop];
        if (!fn) return true;
        return fn(params, n);
      };
    },
  });
  return api;
}
