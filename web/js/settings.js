import { el, clear } from './dom.js';
import { fmt } from './format.js';
import { api } from './api.js';

export class SettingsDialog {
  constructor({ root, providers, roster, onSaved, onToast }) {
    this.root = root;
    this.providers = providers ?? [];
    this.roster = roster ?? [];
    this.onSaved = onSaved;
    this.onToast = onToast;
    this.backdrop = null;
    this.draft = null;
    this.fetchedModels = [];
    this.testResult = null;
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.isOpen) this.close();
    });
  }

  open(config) {
    this.draft = { ...config, table: { ...config.table } };
    this.fetchedModels = [];
    this.testResult = null;
    this.#render();
  }

  close() {
    this.backdrop?.remove();
    this.backdrop = null;
  }

  get isOpen() {
    return Boolean(this.backdrop);
  }

  presetFor(id) {
    return this.providers.find((p) => p.id === id) ?? this.providers[0];
  }

  // ---------------------------------------------------------- form pieces

  #field(label, control, hint) {
    return el('label', { class: 'field' }, [
      el('span', { class: 'field__label', text: label }),
      control,
      hint ? el('span', { class: 'hint', text: hint }) : null,
    ]);
  }

  #input(key, { type = 'text', placeholder = '', table = false } = {}) {
    const target = table ? this.draft.table : this.draft;
    const input = el('input', {
      class: 'input',
      type,
      value: target[key] ?? '',
      placeholder,
      autocomplete: 'off',
      spellcheck: 'false',
    });
    input.addEventListener('input', () => {
      target[key] = type === 'number' ? Number(input.value) : input.value;
    });
    return input;
  }

  #switch(key, title, desc, { table = false } = {}) {
    const target = table ? this.draft.table : this.draft;
    const input = el('input', { type: 'checkbox' });
    input.checked = Boolean(target[key]);
    input.addEventListener('change', () => {
      target[key] = input.checked;
    });
    return el('label', { class: 'switch' }, [
      el('span', { class: 'switch__text' }, [
        el('span', { class: 'switch__title', text: title }),
        el('span', { class: 'switch__desc', text: desc }),
      ]),
      input,
    ]);
  }

  // ------------------------------------------------------------- render

  #render() {
    if (this.backdrop) this.backdrop.remove();

    const providerCards = el(
      'div',
      { class: 'provider-cards' },
      this.providers.map((provider) =>
        el(
          'button',
          {
            class: `provider-card ${this.draft.provider === provider.id ? 'is-active' : ''}`,
            type: 'button',
            on: { click: () => this.#selectProvider(provider.id) },
          },
          [
            el('div', { class: 'provider-card__name', text: provider.label }),
            el('div', {
              class: 'provider-card__meta',
              text: provider.baseUrl || '自定义地址',
            }),
          ],
        ),
      ),
    );

    const modelField = this.#modelField();

    const keyInput = this.#input('apiKey', {
      type: 'password',
      placeholder: this.draft.apiKeyHint ? `已保存 ${this.draft.apiKeyHint}（留空则保持不变）` : '粘贴 API Key',
    });

    const fetchButton = el('button', {
      class: 'btn',
      type: 'button',
      text: '拉取模型列表',
      on: { click: () => this.#fetchModels() },
    });

    const testButton = el('button', {
      class: 'btn',
      type: 'button',
      text: '测试连接',
      on: { click: () => this.#test() },
    });

    const preset = this.presetFor(this.draft.provider);

    const body = el('div', { class: 'modal__body' }, [
      el('div', { class: 'section-title', text: 'AI 供应商' }),
      providerCards,
      preset.docs
        ? el('div', { class: 'hint' }, [
            '文档：',
            el('a', { href: preset.docs, target: '_blank', rel: 'noreferrer', text: preset.docs }),
          ])
        : null,
      preset.id === 'opencode-go'
        ? el('div', {
            class: 'hint',
            text: 'OpenCode Go：在 opencode.ai/auth 订阅 $10/月 的 Go 计划后复制 API Key。本作会自动按模型选择正确的端点（chat/completions、responses 或 messages），并带上 x-opencode-session 会话头。',
          })
        : null,

      el('div', { class: 'grid-2' }, [
        this.#field('Base URL', this.#input('baseUrl', { placeholder: 'https://example.com/v1' })),
        modelField,
      ]),
      el('div', { class: 'field__row' }, [fetchButton, testButton]),

      this.#field(
        'API Key',
        keyInput,
        this.draft.apiKeySource && this.draft.apiKeySource !== 'config'
          ? `当前来自环境变量 ${this.draft.apiKeySource}（环境变量优先于这里保存的值）`
          : '只保存在本机 .data/config.json，不会发送到浏览器之外的地方',
      ),

      el('div', { class: 'section-title', text: '决策参数' }),
      el('div', { class: 'grid-3' }, [
        this.#field('温度', this.#input('temperature', { type: 'number' })),
        this.#field('最大输出 tokens', this.#input('maxTokens', { type: 'number' }), '推理模型的思考 token 也算在这里，建议 ≥1500'),
        this.#field('超时（毫秒）', this.#input('timeoutMs', { type: 'number' })),
      ]),

      el('div', { class: 'grid-3' }, [
        this.#switch('tableTalk', '桌边话', 'AI 会边说边打，气泡显示在头像上'),
        this.#switch('reasoning', '显示推理', '把 AI 的思路显示在实况里'),
        this.#switch('postHandTalk', '赛后点评', '每手结束后每个 AI 用一句话点评结果（每个 AI 一次请求）'),
      ]),
      el('div', { class: 'grid-3' }, [this.#switch('showAiCards', '透视模式', '调试用：显示 AI 底牌')]),

      el('div', { class: 'section-title', text: '牌桌' }),
      el('div', { class: 'grid-2' }, [
        this.#field('座位数（含你）', this.#numberSelect('seats', [2, 3, 4, 5, 6])),
        this.#field('起始筹码', this.#input('startingStack', { type: 'number', table: true })),
      ]),
      el('div', { class: 'grid-2' }, [
        this.#field('小盲', this.#input('smallBlind', { type: 'number', table: true })),
        this.#field('大盲', this.#input('bigBlind', { type: 'number', table: true })),
      ]),

      el('div', { class: 'section-title', text: 'AI 对手阵容' }),
      el(
        'div',
        { class: 'standings' },
        this.#lineup().map((p) =>
          el('div', { class: 'standing' }, [
            el('span', { class: 'standing__avatar', text: p.avatar }),
            el('span', { class: 'standing__name', text: `${p.name}${p.title ? ` · ${p.title}` : ''}` }),
            el('span', { class: 'result-row__hand', text: p.tagline ?? '' }),
          ]),
        ),
      ),

      this.testResult ? this.#testResultNode() : null,
    ]);

    const saveButton = el('button', {
      class: 'btn btn--primary btn--lg',
      type: 'button',
      text: '保存并重开一局',
      on: { click: () => this.#save(true) },
    });
    const saveOnlyButton = el('button', {
      class: 'btn',
      type: 'button',
      text: '仅保存',
      on: { click: () => this.#save(false) },
    });

    const modal = el('div', { class: 'modal' }, [
      el('div', { class: 'modal__head' }, [
        el('div', {}, [
          el('div', { class: 'modal__title', text: '设置' }),
          el('div', { class: 'modal__sub', text: '对手的所有决策都由这里的 LLM 供应商产生' }),
        ]),
        el('button', { class: 'modal__close', type: 'button', text: '✕', on: { click: () => this.close() } }),
      ]),
      body,
      el('div', { class: 'modal__foot' }, [
        saveOnlyButton,
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn', type: 'button', text: '取消', on: { click: () => this.close() } }),
        saveButton,
      ]),
    ]);

    this.backdrop = el(
      'div',
      {
        class: 'modal-backdrop',
        on: {
          click: (event) => {
            if (event.target === this.backdrop) this.close();
          },
        },
      },
      [modal],
    );

    this.root.appendChild(this.backdrop);
  }

  /**
   * Model picker: a real <select> of everything the provider offers, plus a
   * free-text escape hatch.
   *
   * A <datalist> would be the obvious choice, but Chromium filters its dropdown
   * by whatever is already in the box — with "glm-5.3-flash" typed in, that was
   * the only entry a user could ever see or pick.
   */
  #modelField() {
    const preset = this.presetFor(this.draft.provider);
    const seen = new Set();
    const options = [];
    for (const model of preset.models ?? []) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      options.push({ id: model.id, label: model.label ?? model.id, note: model.note ?? '' });
    }
    for (const model of this.fetchedModels) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      options.push({ id: model.id, label: model.label ?? model.id, note: '来自接口' });
    }

    const CUSTOM = '__custom__';
    const known = options.some((o) => o.id === this.draft.model);

    const select = el(
      'select',
      { class: 'select' },
      options.map((o) =>
        el('option', {
          value: o.id,
          text: o.note ? `${o.label} · ${o.id} — ${o.note}` : `${o.label} · ${o.id}`,
        }),
      ).concat([el('option', { value: CUSTOM, text: '✎ 自定义（手动输入模型名）' })]),
    );
    select.value = known ? this.draft.model : CUSTOM;

    const customInput = el('input', {
      class: 'input',
      value: known ? '' : this.draft.model ?? '',
      placeholder: '例如 glm-5.3-flash',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    customInput.style.display = known ? 'none' : '';

    const hint = el('span', { class: 'hint' });
    const refreshHint = () => {
      const match = options.find((o) => o.id === this.draft.model);
      if (match) hint.textContent = match.note || `当前使用 ${match.id}`;
      else if (this.draft.model) hint.textContent = `自定义模型：${this.draft.model}`;
      else hint.textContent = '输入任意模型名';
    };
    refreshHint();

    select.addEventListener('change', () => {
      if (select.value === CUSTOM) {
        customInput.style.display = '';
        this.draft.model = customInput.value.trim();
        customInput.focus();
      } else {
        customInput.style.display = 'none';
        this.draft.model = select.value;
      }
      refreshHint();
    });
    customInput.addEventListener('input', () => {
      this.draft.model = customInput.value.trim();
      refreshHint();
    });

    return el('label', { class: 'field' }, [
      el('span', { class: 'field__label', text: '模型' }),
      el('div', { class: 'model-picker' }, [select, customInput]),
      hint,
    ]);
  }

  #numberSelect(key, values) {
    const select = el(
      'select',
      { class: 'select' },
      values.map((v) => el('option', { value: String(v), text: `${v} 人` })),
    );
    select.value = String(this.draft.table[key]);
    select.addEventListener('change', () => {
      this.draft.table[key] = Number(select.value);
    });
    return select;
  }

  #lineup() {
    const byId = new Map(this.roster.map((p) => [p.id, p]));
    const order = ['ivan', 'biao', 'jiu', 'lisa', 'nana', 'kongming', 'wei'];
    const count = Math.max(0, Number(this.draft.table.seats) - 1);
    return order.slice(0, count).map((id) => byId.get(id)).filter(Boolean);
  }

  #testResultNode() {
    const result = this.testResult;
    const ok = result.ok;
    return el('div', { class: `test-result ${ok ? 'test-result--ok' : 'test-result--fail'}` }, [
      el('span', { class: `status-dot ${ok ? 'status-dot--ok' : 'status-dot--fail'}` }),
      el('div', {}, [
        el('div', {
          text: ok
            ? `连接成功 · ${result.latencyMs}ms · 协议 ${result.wire}`
            : `连接失败 · ${result.code ?? 'ERROR'}${result.status ? ` (HTTP ${result.status})` : ''}`,
        }),
        el('div', { class: 'hint', text: ok ? `模型返回：${result.sample || '(空)'}` : result.error || '未知错误' }),
        ok && result.note ? el('div', { class: 'hint', text: `⚠ ${result.note}` }) : null,
        ok && result.usage
          ? el('div', { class: 'hint', text: `tokens: ${JSON.stringify(result.usage)}` })
          : null,
      ]),
    ]);
  }

  // ------------------------------------------------------------- actions

  #selectProvider(id) {
    const preset = this.presetFor(id);
    this.draft.provider = id;
    if (preset.baseUrl) this.draft.baseUrl = preset.baseUrl;
    if (preset.defaultModel) this.draft.model = preset.defaultModel;
    this.fetchedModels = [];
    this.testResult = null;
    this.#render();
  }

  async #fetchModels() {
    try {
      const result = await api.models({
        provider: this.draft.provider,
        baseUrl: this.draft.baseUrl ?? '',
        apiKey: this.draft.apiKey ?? '',
      });
      if (!result.ok && !result.models?.length) throw new Error(result.error ?? '拉取失败');
      this.fetchedModels = result.models ?? [];
      this.onToast?.({ level: 'success', message: `已获取 ${this.fetchedModels.length} 个模型` });
      this.#render();
    } catch (err) {
      this.onToast?.({ level: 'error', message: `拉取模型失败：${err.message}` });
    }
  }

  async #test() {
    this.testResult = { ok: false, error: '测试中…' };
    this.#render();
    try {
      this.testResult = await api.testConfig({
        provider: this.draft.provider,
        baseUrl: this.draft.baseUrl,
        model: this.draft.model,
        apiKey: this.draft.apiKey,
        timeoutMs: this.draft.timeoutMs,
      });
    } catch (err) {
      this.testResult = { ok: false, error: err.message };
    }
    this.#render();
  }

  async #save(restart) {
    const patch = {
      provider: this.draft.provider,
      baseUrl: this.draft.baseUrl,
      model: this.draft.model,
      temperature: this.draft.temperature,
      maxTokens: this.draft.maxTokens,
      timeoutMs: this.draft.timeoutMs,
      tableTalk: this.draft.tableTalk,
      reasoning: this.draft.reasoning,
      showAiCards: this.draft.showAiCards,
      postHandTalk: this.draft.postHandTalk,
      table: { ...this.draft.table },
    };
    // Only send the key when the user actually typed one.
    if (this.draft.apiKey !== undefined && this.draft.apiKey !== null) patch.apiKey = this.draft.apiKey;

    try {
      const result = await api.saveConfig(patch);
      this.onToast?.({ level: 'success', message: '设置已保存' });
      this.close();
      await this.onSaved?.(result.config, { restart });
    } catch (err) {
      this.onToast?.({ level: 'error', message: `保存失败：${err.message}` });
    }
  }
}

export { fmt };
