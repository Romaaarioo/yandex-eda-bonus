(() => {
  'use strict';

  const LOCATION = {
    name: 'Зональная Станция',
    latitude: 56.42995,
    longitude: 85.01547,
    timezone: 'Asia/Tomsk',
  };

  const STORAGE_KEY = 'bonus-calculator:v2';
  const THEME_KEY = 'bonus-calculator:theme';
  const DEFAULT_STATE = {
    orders: 100,
    bonus: 5000,
    ordersPerHour: 1.5,
    baseRate: 200,
  };
  const MAX_RANGE_DAYS = 31;
  const WEATHER_PAST_DAYS = 92;
  const WEATHER_FUTURE_DAYS = 15;
  const WEATHER_CACHE_TTL = 30 * 60 * 1000;

  const WEEKDAYS_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  const MONTHS_GENITIVE = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
  ];

  const todayFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: LOCATION.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const moneyFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  const decimalFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
  const timeFormatter = new Intl.DateTimeFormat('ru-RU', {
    timeZone: LOCATION.timezone,
    hour: '2-digit',
    minute: '2-digit',
  });

  const $ = (id) => document.getElementById(id);

  const els = {
    metaTheme: document.querySelector('meta[name="theme-color"]'),
    themeToggle: $('theme-toggle'),
    start: $('start-date'),
    end: $('end-date'),
    orders: $('orders'),
    bonus: $('bonus'),
    ordersPerHour: $('orders-per-hour'),
    baseRate: $('base-rate'),
    assumptionBadge: $('assumption-badge'),
    assumptionsSummary: $('assumptions-summary'),
    formError: $('form-error'),
    formHint: $('form-hint'),
    quickRanges: $('quick-ranges'),
    resultCard: $('result-card'),
    resultPeriod: $('result-period'),
    effectiveRate: $('effective-rate'),
    rateDelta: $('rate-delta'),
    totalPayout: $('total-payout'),
    basePay: $('base-pay'),
    bonusPay: $('bonus-pay'),
    splitBar: $('split-bar'),
    baseBar: $('base-bar'),
    bonusBar: $('bonus-bar'),
    hoursTotal: $('hours-total'),
    hoursPerDay: $('hours-per-day'),
    ordersPerDay: $('orders-per-day'),
    shifts: $('shifts'),
    insight: $('insight'),
    insightText: $('insight-text'),
    weatherSubtitle: $('weather-subtitle'),
    weatherSummary: $('weather-summary'),
    weatherUpdated: $('weather-updated'),
    weatherGrid: $('weather-grid'),
  };

  let today = todayISO();
  let hintTimer = null;
  let themeTimer = null;
  let weatherDebounceTimer = null;
  let weatherAbort = null;
  let weatherRequestToken = 0;
  let weatherStatus = 'idle';
  let weatherErrorText = '';
  let weatherData = null;
  let lastWeatherKey = '';
  const weatherCache = new Map();

  function init() {
    today = todayISO();
    applyTheme(getInitialTheme(), false);
    bindThemeEvents();
    restoreState();
    updateDateBounds();
    bindFormEvents();
    bindQuickRanges();
    refresh({ initial: true });
  }

  function storageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* localStorage may be unavailable */
    }
  }

  function readJSON(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function getInitialTheme() {
    const saved = storageGet(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  function applyTheme(theme, animate) {
    document.documentElement.setAttribute('data-theme', theme);
    if (els.metaTheme) {
      els.metaTheme.setAttribute('content', theme === 'dark' ? '#000000' : '#f5f5f7');
    }
    if (els.themeToggle) {
      const nextLabel = theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему';
      els.themeToggle.setAttribute('aria-label', nextLabel);
      els.themeToggle.setAttribute('title', nextLabel);
    }
    if (animate) {
      document.body.classList.add('theme-transition');
      window.clearTimeout(themeTimer);
      themeTimer = window.setTimeout(() => {
        document.body.classList.remove('theme-transition');
      }, 380);
    }
  }

  function bindThemeEvents() {
    els.themeToggle.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next, true);
      storageSet(THEME_KEY, next);
    });

    if (window.matchMedia) {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = (event) => {
        if (!storageGet(THEME_KEY)) {
          applyTheme(event.matches ? 'dark' : 'light', true);
        }
      };
      if (media.addEventListener) media.addEventListener('change', onChange);
      else if (media.addListener) media.addListener(onChange);
    }
  }

  function restoreState() {
    const saved = readJSON(STORAGE_KEY);
    let start = today;
    let end = addDays(today, 6);

    if (saved && isValidISODate(saved.start) && isValidISODate(saved.end)) {
      const range = daysBetween(saved.start, saved.end);
      const notTooOld = saved.start >= addDays(today, -WEATHER_PAST_DAYS);
      const notFinished = saved.end >= today;
      if (saved.start <= saved.end && range <= MAX_RANGE_DAYS && notTooOld && notFinished) {
        start = saved.start;
        end = saved.end;
      }
    }

    els.start.value = start;
    els.end.value = end;
    els.orders.value = String(validNumber(saved && saved.orders, DEFAULT_STATE.orders, 1, 100000));
    els.bonus.value = String(validNumber(saved && saved.bonus, DEFAULT_STATE.bonus, 0, 1000000));
    els.ordersPerHour.value = String(
      validNumber(saved && saved.ordersPerHour, DEFAULT_STATE.ordersPerHour, 0.1, 100)
    );
    els.baseRate.value = String(validNumber(saved && saved.baseRate, DEFAULT_STATE.baseRate, 0, 100000));
  }

  function saveState(values) {
    if (!isValidISODate(values.start) || !isValidISODate(values.end) || values.end < values.start) return;
    const payload = {
      start: values.start,
      end: values.end,
      orders: Number.isFinite(values.orders) ? values.orders : null,
      bonus: Number.isFinite(values.bonus) ? values.bonus : null,
      ordersPerHour: values.ordersPerHour,
      baseRate: values.baseRate,
    };
    storageSet(STORAGE_KEY, JSON.stringify(payload));
  }

  function validNumber(value, fallback, min, max) {
    if (value === null || value === undefined || value === '') return fallback;
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function todayISO() {
    return todayFormatter.format(new Date());
  }

  function parseISODate(iso) {
    if (typeof iso !== 'string') return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month, day, 12, 0, 0));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month ||
      date.getUTCDate() !== day
    ) {
      return null;
    }
    return date;
  }

  function isValidISODate(iso) {
    return Boolean(parseISODate(iso));
  }

  function addDays(iso, days) {
    const date = parseISODate(iso);
    if (!date) return '';
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function daysBetween(start, end) {
    const from = parseISODate(start);
    const to = parseISODate(end);
    if (!from || !to) return 0;
    return Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
  }

  function dateList(start, end) {
    if (!isValidISODate(start) || !isValidISODate(end) || end < start) return [];
    const result = [];
    let cursor = start;
    let guard = 0;
    while (cursor <= end && guard < 400) {
      result.push(cursor);
      cursor = addDays(cursor, 1);
      guard += 1;
    }
    return result;
  }

  function formatDayMonth(iso) {
    const date = parseISODate(iso);
    if (!date) return '';
    return `${date.getUTCDate()} ${MONTHS_GENITIVE[date.getUTCMonth()]}`;
  }

  function formatFullDate(iso, forceYear) {
    const date = parseISODate(iso);
    if (!date) return '';
    const current = parseISODate(today);
    const showYear = forceYear || !current || date.getUTCFullYear() !== current.getUTCFullYear();
    return `${formatDayMonth(iso)}${showYear ? ` ${date.getUTCFullYear()}` : ''}`;
  }

  function formatRange(start, end) {
    const from = parseISODate(start);
    const to = parseISODate(end);
    if (!from || !to) return '';
    if (start === end) return formatFullDate(start, false);
    if (from.getUTCFullYear() !== to.getUTCFullYear()) {
      return `${formatFullDate(start, true)} — ${formatFullDate(end, true)}`;
    }
    const current = parseISODate(today);
    const showYear = !current || from.getUTCFullYear() !== current.getUTCFullYear();
    return `${formatDayMonth(start)} — ${formatDayMonth(end)}${showYear ? ` ${from.getUTCFullYear()}` : ''}`;
  }

  function formatWeekday(iso) {
    const date = parseISODate(iso);
    return date ? WEEKDAYS_SHORT[date.getUTCDay()] : '';
  }

  function plural(number, forms) {
    const abs = Math.abs(number) % 100;
    const last = abs % 10;
    if (abs > 10 && abs < 20) return forms[2];
    if (last > 1 && last < 5) return forms[1];
    if (last === 1) return forms[0];
    return forms[2];
  }

  function formatMoney(value) {
    return Number.isFinite(value) ? moneyFormatter.format(Math.round(value)) : '—';
  }

  function formatDecimal(value) {
    return Number.isFinite(value) ? decimalFormatter.format(value) : '—';
  }

  function formatHours(value) {
    return Number.isFinite(value) ? decimalFormatter.format(value) : '—';
  }

  function formatTemp(value) {
    if (!Number.isFinite(value)) return '—';
    const rounded = Math.round(value);
    if (rounded === 0) return '0°';
    return rounded < 0 ? `−${Math.abs(rounded)}°` : `${rounded}°`;
  }

  function formatTime(timestamp) {
    return timeFormatter.format(new Date(timestamp));
  }

  function readForm() {
    const ordersRaw = els.orders.value.trim();
    const bonusRaw = els.bonus.value.trim();
    const ordersPerHourRaw = els.ordersPerHour.value.trim();
    const baseRateRaw = els.baseRate.value.trim();

    const orders = ordersRaw === '' ? NaN : Number(ordersRaw);
    const bonus = bonusRaw === '' ? 0 : Number(bonusRaw);
    const ordersPerHour = ordersPerHourRaw === '' ? NaN : Number(ordersPerHourRaw);
    const baseRate = baseRateRaw === '' ? NaN : Number(baseRateRaw);

    return {
      start: els.start.value,
      end: els.end.value,
      orders,
      bonus,
      ordersPerHour:
        Number.isFinite(ordersPerHour) && ordersPerHour > 0
          ? ordersPerHour
          : DEFAULT_STATE.ordersPerHour,
      baseRate:
        Number.isFinite(baseRate) && baseRate >= 0 ? baseRate : DEFAULT_STATE.baseRate,
    };
  }

  function validate(values) {
    const errors = [];

    if (!isValidISODate(values.start) || !isValidISODate(values.end)) {
      errors.push('Укажите начало и конец периода.');
    } else if (values.end < values.start) {
      errors.push('Конец периода не может быть раньше начала.');
    } else if (daysBetween(values.start, values.end) > MAX_RANGE_DAYS) {
      errors.push(`Период — не больше ${MAX_RANGE_DAYS} дней.`);
    }

    if (!Number.isFinite(values.orders) || values.orders <= 0) {
      errors.push('Укажите количество заказов больше нуля.');
    }

    if (!Number.isFinite(values.bonus) || values.bonus < 0) {
      errors.push('Бонус не может быть отрицательным.');
    }

    return errors;
  }

  function getDateError(values) {
    if (!isValidISODate(values.start) || !isValidISODate(values.end)) {
      return 'Укажите начало и конец периода.';
    }
    if (values.end < values.start) {
      return 'Конец периода не может быть раньше начала.';
    }
    if (daysBetween(values.start, values.end) > MAX_RANGE_DAYS) {
      return `Период — не больше ${MAX_RANGE_DAYS} дней.`;
    }
    return '';
  }

  function refresh(options = {}) {
    const values = readForm();
    updateAssumptions(values);
    updateQuickRangeState(values);
    const errors = validate(values);
    renderResult(values, errors);
    setFormError(getDateError(values));
    saveState(values);

    const dateError = getDateError(values);
    if (!dateError) {
      const key = `${values.start}_${values.end}`;
      if (key !== lastWeatherKey) {
        lastWeatherKey = key;
        scheduleWeather(options.initial ? 0 : 450);
      }
    } else {
      lastWeatherKey = '';
      cancelWeather();
      weatherStatus = 'idle';
      weatherErrorText = '';
      weatherData = null;
      renderWeather();
    }
  }

  function updateAssumptions(values) {
    const ordersPerHour = formatDecimal(values.ordersPerHour);
    const baseRate = formatDecimal(values.baseRate);
    if (els.assumptionBadge) {
      els.assumptionBadge.textContent = `≈ ${ordersPerHour} зак./ч`;
    }
    els.assumptionsSummary.textContent = `${ordersPerHour} зак./ч · ${baseRate} ₽/ч`;
  }

  function updateQuickRangeState(values) {
    const buttons = els.quickRanges.querySelectorAll('button[data-range]');
    buttons.forEach((button) => {
      const range = rangeForMode(button.dataset.range);
      const active = Boolean(
        range && values.start === range.start && values.end === range.end
      );
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function rangeForMode(mode) {
    if (mode === 'today') return { start: today, end: today };
    if (mode === '3') return { start: today, end: addDays(today, 2) };
    if (mode === '7') return { start: today, end: addDays(today, 6) };
    if (mode === 'weekend') return weekendRange();
    return null;
  }

  function weekendRange() {
    const date = parseISODate(today);
    if (!date) return { start: today, end: today };
    const day = date.getUTCDay();
    if (day === 6) return { start: today, end: addDays(today, 1) };
    if (day === 0) return { start: addDays(today, -1), end: today };
    const saturday = addDays(today, (6 - day + 7) % 7);
    return { start: saturday, end: addDays(saturday, 1) };
  }

  function bindQuickRanges() {
    els.quickRanges.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-range]');
      if (!button) return;
      const range = rangeForMode(button.dataset.range);
      if (!range) return;
      els.start.value = range.start;
      els.end.value = range.end;
      updateDateBounds();
      refresh();
    });
  }

  function bindFormEvents() {
    els.start.addEventListener('change', () => {
      clampDateRange('start');
      updateDateBounds();
      refresh();
    });

    els.end.addEventListener('change', () => {
      clampDateRange('end');
      updateDateBounds();
      refresh();
    });

    [els.orders, els.bonus, els.ordersPerHour, els.baseRate].forEach((input) => {
      input.addEventListener('input', () => refresh());
      input.addEventListener('change', () => refresh());
    });

    els.ordersPerHour.addEventListener('blur', () => {
      normalizeAssumptionInput(els.ordersPerHour, DEFAULT_STATE.ordersPerHour, 0.1, 100);
    });

    els.baseRate.addEventListener('blur', () => {
      normalizeAssumptionInput(els.baseRate, DEFAULT_STATE.baseRate, 0, 100000);
    });
  }

  function clampDateRange() {
    const start = els.start.value;
    const end = els.end.value;
    if (!isValidISODate(start) || !isValidISODate(end)) return;

    if (end < start) {
      els.end.value = start;
      showHint('Конец периода сдвинут к дате начала.');
    }

    const maxEnd = addDays(start, MAX_RANGE_DAYS - 1);
    if (els.end.value > maxEnd) {
      els.end.value = maxEnd;
      showHint(`Период ограничен ${MAX_RANGE_DAYS} днями.`);
    }
  }

  function updateDateBounds() {
    const min = addDays(today, -WEATHER_PAST_DAYS);
    const max = addDays(today, 365);
    els.start.min = min;
    els.start.max = max;

    if (isValidISODate(els.start.value)) {
      els.end.min = els.start.value;
      els.end.max = addDays(els.start.value, MAX_RANGE_DAYS - 1);
    } else {
      els.end.min = min;
      els.end.max = max;
    }
  }

  function normalizeAssumptionInput(input, fallback, min, max) {
    if (input.value.trim() === '') {
      input.value = String(fallback);
      refresh();
      return;
    }
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < min || value > max) {
      input.value = String(fallback);
      refresh();
    }
  }

  function showHint(text) {
    if (!els.formHint) return;
    els.formHint.textContent = text;
    els.formHint.hidden = false;
    window.clearTimeout(hintTimer);
    hintTimer = window.setTimeout(() => {
      els.formHint.hidden = true;
    }, 4000);
  }

  function setFormError(text) {
    if (!els.formError) return;
    if (text) {
      els.formError.textContent = text;
      els.formError.hidden = false;
    } else {
      els.formError.textContent = '';
      els.formError.hidden = true;
    }
  }

  function compute(values) {
    const days = daysBetween(values.start, values.end);
    const hours = values.orders / values.ordersPerHour;
    const basePay = hours * values.baseRate;
    const total = basePay + values.bonus;
    const effective = hours > 0 ? total / hours : values.baseRate;
    const delta = effective - values.baseRate;
    const deltaPct = values.baseRate > 0 ? (delta / values.baseRate) * 100 : 0;
    const baseShare = total > 0 ? (basePay / total) * 100 : 0;

    return {
      days,
      hours,
      basePay,
      total,
      effective,
      delta,
      deltaPct,
      hoursPerDay: hours / days,
      ordersPerDay: values.orders / days,
      shifts: hours / 8,
      baseShare: Math.min(100, Math.max(0, baseShare)),
    };
  }

  function renderResult(values, errors) {
    const result = errors.length === 0 ? compute(values) : null;
    els.resultCard.classList.toggle('is-empty', !result);
    els.resultPeriod.textContent = getPeriodLabel(values);

    if (!result) {
      els.effectiveRate.textContent = '—';
      els.totalPayout.textContent = '—';
      els.basePay.textContent = '—';
      els.bonusPay.textContent = '—';
      els.hoursTotal.textContent = '—';
      els.hoursPerDay.textContent = '—';
      els.ordersPerDay.textContent = '—';
      els.shifts.textContent = '—';
      els.baseBar.style.width = '0%';
      els.bonusBar.style.width = '0%';
      els.splitBar.setAttribute('aria-label', 'Состав выплаты пока не рассчитан');
      els.rateDelta.hidden = true;
      setInsight('neutral', getEmptyMessage(values));
      return;
    }

    els.effectiveRate.textContent = formatMoney(result.effective);
    els.totalPayout.textContent = `${formatMoney(result.total)} ₽`;
    els.basePay.textContent = `${formatMoney(result.basePay)} ₽`;
    els.bonusPay.textContent = `${formatMoney(values.bonus)} ₽`;

    const baseWidth = result.baseShare;
    const hasTotal = result.total > 0;
    els.baseBar.style.width = hasTotal ? `${baseWidth}%` : '0%';
    els.bonusBar.style.width = hasTotal ? `${100 - baseWidth}%` : '0%';
    els.splitBar.setAttribute(
      'aria-label',
      `Базовая оплата ${formatMoney(result.basePay)} рублей, бонус ${formatMoney(values.bonus)} рублей`
    );

    els.hoursTotal.textContent = `${formatHours(result.hours)} ч`;
    els.hoursPerDay.textContent = `${formatHours(result.hoursPerDay)} ч`;
    els.ordersPerDay.textContent = formatDecimal(result.ordersPerDay);
    els.shifts.textContent = formatDecimal(result.shifts);

    els.rateDelta.hidden = false;
    if (values.bonus > 0) {
      const percent = values.baseRate > 0 ? ` · +${formatDecimal(result.deltaPct)}%` : '';
      els.rateDelta.dataset.tone = 'positive';
      els.rateDelta.textContent = `+${formatDecimal(result.delta)} ₽/ч${percent}`;
    } else {
      els.rateDelta.dataset.tone = 'neutral';
      els.rateDelta.textContent = 'Базовая ставка без бонуса';
    }

    const insight = getInsight(values, result);
    setInsight(insight.tone, insight.text);
  }

  function getPeriodLabel(values) {
    if (!isValidISODate(values.start) || !isValidISODate(values.end) || values.end < values.start) {
      return 'Выберите период';
    }
    const days = daysBetween(values.start, values.end);
    return `${formatRange(values.start, values.end)} · ${days} ${plural(days, ['день', 'дня', 'дней'])}`;
  }

  function getEmptyMessage(values) {
    if (
      !isValidISODate(values.start) ||
      !isValidISODate(values.end) ||
      values.end < values.start
    ) {
      return 'Выберите корректный период.';
    }
    if (daysBetween(values.start, values.end) > MAX_RANGE_DAYS) {
      return `Период — не больше ${MAX_RANGE_DAYS} дней.`;
    }
    if (!Number.isFinite(values.orders) || values.orders <= 0) {
      return 'Укажите количество заказов — и расчёт появится.';
    }
    if (!Number.isFinite(values.bonus) || values.bonus < 0) {
      return 'Бонус не может быть отрицательным.';
    }
    return 'Заполните параметры, чтобы увидеть расчёт.';
  }

  function getInsight(values, result) {
    if (values.bonus <= 0) {
      return {
        tone: 'neutral',
        text: 'Бонус не указан — считаем только базовую оплату.',
      };
    }

    if (result.hoursPerDay > 14) {
      return {
        tone: 'danger',
        text: `Очень плотный график: ${formatHours(result.hoursPerDay)} ч в день. Лучше увеличить срок или снизить цель.`,
      };
    }

    if (result.hoursPerDay > 9) {
      return {
        tone: 'warning',
        text: `Плотный график: ${formatHours(result.hoursPerDay)} ч в день без выходных. Заложите запас на медленные дни.`,
      };
    }

    if (result.hoursPerDay > 7) {
      return {
        tone: 'neutral',
        text: `В среднем ${formatHours(result.hoursPerDay)} ч в день — с учётом всех дней периода.`,
      };
    }

    return {
      tone: 'success',
      text: `Комфортный темп: около ${formatHours(result.hoursPerDay)} ч в день. Останется время на отдых.`,
    };
  }

  function setInsight(tone, text) {
    els.insight.dataset.tone = tone;
    els.insightText.textContent = text;
  }

  function scheduleWeather(delay = 450) {
    cancelWeather();
    weatherStatus = 'loading';
    weatherErrorText = '';
    renderWeather();
    if (delay <= 0) {
      loadWeather();
      return;
    }
    weatherDebounceTimer = window.setTimeout(loadWeather, delay);
  }

  function cancelWeather() {
    weatherRequestToken += 1;
    window.clearTimeout(weatherDebounceTimer);
    weatherDebounceTimer = null;
    if (weatherAbort) {
      weatherAbort.abort();
      weatherAbort = null;
    }
  }

  async function loadWeather() {
    weatherDebounceTimer = null;
    const start = els.start.value;
    const end = els.end.value;

    if (!isValidISODate(start) || !isValidISODate(end) || end < start) {
      weatherStatus = 'idle';
      weatherData = null;
      weatherErrorText = '';
      renderWeather();
      return;
    }

    const supportedStart = addDays(today, -WEATHER_PAST_DAYS);
    const supportedEnd = addDays(today, WEATHER_FUTURE_DAYS);
    const fetchStart = start > supportedStart ? start : supportedStart;
    const fetchEnd = end < supportedEnd ? end : supportedEnd;

    if (fetchStart > fetchEnd) {
      weatherStatus = 'unavailable';
      weatherData = { byDate: new Map(), fetchedAt: null, key: '' };
      weatherErrorText = '';
      renderWeather();
      return;
    }

    const cacheKey = `${fetchStart}_${fetchEnd}`;
    const cached = weatherCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < WEATHER_CACHE_TTL) {
      weatherStatus = 'success';
      weatherData = { byDate: cached.byDate, fetchedAt: cached.fetchedAt, key: cacheKey };
      weatherErrorText = '';
      renderWeather();
      return;
    }

    const token = ++weatherRequestToken;
    const controller = new AbortController();
    weatherAbort = controller;
    weatherStatus = 'loading';
    weatherErrorText = '';
    renderWeather();

    try {
      const url = new URL('https://api.open-meteo.com/v1/forecast');
      url.searchParams.set('latitude', String(LOCATION.latitude));
      url.searchParams.set('longitude', String(LOCATION.longitude));
      url.searchParams.set(
        'hourly',
        'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m'
      );
      url.searchParams.set(
        'daily',
        'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max'
      );
      url.searchParams.set('timezone', LOCATION.timezone);
      url.searchParams.set('wind_speed_unit', 'ms');
      url.searchParams.set('start_date', fetchStart);
      url.searchParams.set('end_date', fetchEnd);

      const response = await fetch(url.toString(), { signal: controller.signal });
      if (!response.ok) throw new Error(`Weather request failed: ${response.status}`);
      const payload = await response.json();
      if (token !== weatherRequestToken) return;

      const byDate = parseWeather(payload);
      const fetchedAt = Date.now();
      weatherCache.set(cacheKey, { byDate, fetchedAt });
      weatherStatus = 'success';
      weatherData = { byDate, fetchedAt, key: cacheKey };
      weatherErrorText = '';
      renderWeather();
    } catch (error) {
      if (error.name === 'AbortError' || token !== weatherRequestToken) return;
      weatherStatus = 'error';
      weatherErrorText = 'Не удалось загрузить прогноз. Проверьте соединение и попробуйте ещё раз.';
      weatherData = null;
      renderWeather();
    } finally {
      if (weatherAbort === controller) weatherAbort = null;
    }
  }

  function parseWeather(payload) {
    const byDate = new Map();
    const hourly = payload && payload.hourly ? payload.hourly : {};
    const daily = payload && payload.daily ? payload.daily : {};
    const hourlyTimes = Array.isArray(hourly.time) ? hourly.time : [];
    const dailyTimes = Array.isArray(daily.time) ? daily.time : [];
    const hourlyIndex = new Map(hourlyTimes.map((time, index) => [time, index]));
    const dailyIndex = new Map(dailyTimes.map((time, index) => [time, index]));

    dailyTimes.forEach((date) => {
      const dayIndex = dailyIndex.get(date);
      const hours = ['09:00', '14:00', '19:00'].map((time) => {
        const index = hourlyIndex.get(`${date}T${time}`);
        if (index === undefined) return null;
        return {
          time,
          temp: numberOrNull(hourly.temperature_2m && hourly.temperature_2m[index]),
          feels: numberOrNull(hourly.apparent_temperature && hourly.apparent_temperature[index]),
          wind: numberOrNull(hourly.wind_speed_10m && hourly.wind_speed_10m[index]),
          precipProb: numberOrNull(
            hourly.precipitation_probability && hourly.precipitation_probability[index]
          ),
          precip: numberOrNull(hourly.precipitation && hourly.precipitation[index]),
          code: numberOrNull(hourly.weather_code && hourly.weather_code[index]),
        };
      });

      const dailyCode = numberOrNull(daily.weather_code && daily.weather_code[dayIndex]);
      byDate.set(date, {
        date,
        code: dailyCode === null ? (hours[1] && hours[1].code) || 0 : dailyCode,
        tempMax: numberOrNull(daily.temperature_2m_max && daily.temperature_2m_max[dayIndex]),
        tempMin: numberOrNull(daily.temperature_2m_min && daily.temperature_2m_min[dayIndex]),
        precipSum: numberOrNull(daily.precipitation_sum && daily.precipitation_sum[dayIndex]),
        precipProb: numberOrNull(
          daily.precipitation_probability_max && daily.precipitation_probability_max[dayIndex]
        ),
        windMax: numberOrNull(daily.wind_speed_10m_max && daily.wind_speed_10m_max[dayIndex]),
        hours,
      });
    });

    return byDate;
  }

  function numberOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  const WEATHER_CODES = {
    0: { label: 'Ясно', group: 'clear' },
    1: { label: 'Преимущественно ясно', group: 'clear' },
    2: { label: 'Переменная облачность', group: 'cloud' },
    3: { label: 'Пасмурно', group: 'cloud' },
    45: { label: 'Туман', group: 'fog' },
    48: { label: 'Изморозь', group: 'fog' },
    51: { label: 'Слабая морось', group: 'rain' },
    53: { label: 'Морось', group: 'rain' },
    55: { label: 'Сильная морось', group: 'rain' },
    56: { label: 'Ледяная морось', group: 'rain' },
    57: { label: 'Сильная ледяная морось', group: 'rain' },
    61: { label: 'Небольшой дождь', group: 'rain' },
    63: { label: 'Дождь', group: 'rain' },
    65: { label: 'Сильный дождь', group: 'rain' },
    66: { label: 'Ледяной дождь', group: 'rain' },
    67: { label: 'Сильный ледяной дождь', group: 'rain' },
    71: { label: 'Небольшой снег', group: 'snow' },
    73: { label: 'Снег', group: 'snow' },
    75: { label: 'Сильный снег', group: 'snow' },
    77: { label: 'Снежная крупа', group: 'snow' },
    80: { label: 'Небольшой ливень', group: 'rain' },
    81: { label: 'Ливень', group: 'rain' },
    82: { label: 'Сильный ливень', group: 'rain' },
    85: { label: 'Небольшой снегопад', group: 'snow' },
    86: { label: 'Сильный снегопад', group: 'snow' },
    95: { label: 'Гроза', group: 'storm' },
    96: { label: 'Гроза с градом', group: 'storm' },
    99: { label: 'Сильная гроза с градом', group: 'storm' },
  };

  function weatherMeta(code) {
    return WEATHER_CODES[code] || { label: 'Переменная облачность', group: 'cloud' };
  }

  function weatherIconKey(code) {
    if (code === 0) return 'sun';
    if (code === 1 || code === 2) return 'partly';
    if (code === 3) return 'cloud';
    if (code === 45 || code === 48) return 'fog';
    if (code >= 95) return 'storm';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
    return 'cloud';
  }

  function weatherIconHtml(key) {
    if (key === 'sun') {
      return `<svg viewBox="0 0 32 32" aria-hidden="true">
        <circle class="wi-sun" cx="16" cy="16" r="5.8"/>
        <g class="wi-rays"><path d="M16 3.2v3.2M16 25.6v3.2M3.2 16h3.2M25.6 16h3.2M6.9 6.9l2.3 2.3M22.8 22.8l2.3 2.3M25.1 6.9l-2.3 2.3M9.2 22.8l-2.3 2.3"/></g>
      </svg>`;
    }

    if (key === 'partly') {
      return `<svg viewBox="0 0 32 32" aria-hidden="true">
        <circle class="wi-sun" cx="12" cy="12" r="4.6"/>
        <g class="wi-rays"><path d="M12 2.8v2.5M12 18.7v2.5M2.8 12h2.5M18.7 12h2.5M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8"/></g>
        <path class="wi-cloud" d="M12.5 25.5h11.2a4.1 4.1 0 0 0 .5-8.2 6.2 6.2 0 0 0-11.7-1.1 4.8 4.8 0 0 0 0 9.3Z"/>
      </svg>`;
    }

    if (key === 'rain') {
      return `<svg viewBox="0 0 32 32" aria-hidden="true">
        <path class="wi-cloud" d="M7.8 20.2h15.5a4.5 4.5 0 0 0 .5-8.9A7 7 0 0 0 10 10.1a5.4 5.4 0 0 0-2.2 10.1Z"/>
        <g class="wi-rain"><path d="M11.2 23.4 10 27.1M16 23.4l-1.2 3.7M20.8 23.4l-1.2 3.7"/></g>
      </svg>`;
    }

    if (key === 'snow') {
      return `<svg viewBox="0 0 32 32" aria-hidden="true">
        <path class="wi-cloud" d="M7.8 19.6h15.5a4.5 4.5 0 0 0 .5-8.9A7 7 0 0 0 10 9.5a5.4 5.4 0 0 0-2.2 10.1Z"/>
        <g class="wi-snow"><path d="M11 23v4M9.3 24l3.4 2M12.7 24l-3.4 2M21 23v4M19.3 24l3.4 2M22.7 24l-3.4 2"/></g>
      </svg>`;
    }

    if (key === 'storm') {
      return `<svg viewBox="0 0 32 32" aria-hidden="true">
        <path class="wi-cloud" d="M7.8 19.2h15.5a4.5 4.5 0 0 0 .5-8.9A7 7 0 0 0 10 9.1a5.4 5.4 0 0 0-2.2 10.1Z"/>
        <path class="wi-bolt" d="M17.2 18.7 12.6 25h3.6l-1.1 4.2 4.9-6.7h-3.4l.6-3.8Z"/>
      </svg>`;
    }

    if (key === 'fog') {
      return `<svg viewBox="0 0 32 32" aria-hidden="true">
        <path class="wi-cloud" d="M7.8 18.5h15.5a4.5 4.5 0 0 0 .5-8.9A7 7 0 0 0 10 8.4a5.4 5.4 0 0 0-2.2 10.1Z"/>
        <g class="wi-fog"><path d="M8.5 23h15M11 26.2h10M13.5 29.4h5"/></g>
      </svg>`;
    }

    return `<svg viewBox="0 0 32 32" aria-hidden="true">
      <path class="wi-cloud" d="M8.6 24.5h14.7a4.7 4.7 0 0 0 .6-9.3 7.2 7.2 0 0 0-13.7-1.2 5.6 5.6 0 0 0-1.6 10.5Z"/>
    </svg>`;
  }

  function renderWeather() {
    const dates = dateList(els.start.value, els.end.value);
    updateWeatherHeading(dates);

    if (!dates.length) {
      els.weatherGrid.innerHTML = emptyWeatherHtml(
        'Выберите период',
        'Погода появится, когда будут выбраны даты.'
      );
      els.weatherGrid.setAttribute('aria-busy', 'false');
      return;
    }

    if (weatherStatus === 'loading') {
      els.weatherGrid.innerHTML = skeletonCards(Math.min(dates.length, 8));
      els.weatherGrid.setAttribute('aria-busy', 'true');
      return;
    }

    if (weatherStatus === 'error') {
      els.weatherGrid.innerHTML = errorWeatherHtml(weatherErrorText);
      els.weatherGrid.setAttribute('aria-busy', 'false');
      const retry = $('weather-retry');
      if (retry) retry.addEventListener('click', () => loadWeather());
      return;
    }

    if (!weatherData || !weatherData.byDate) {
      els.weatherGrid.innerHTML = emptyWeatherHtml(
        'Выберите период',
        'Погода появится, когда будут выбраны даты.'
      );
      els.weatherGrid.setAttribute('aria-busy', 'false');
      return;
    }

    const cards = dates.map((date, index) => {
      const day = weatherData.byDate.get(date);
      return day ? weatherCardHtml(day, index) : placeholderCardHtml(date, index);
    });

    els.weatherGrid.innerHTML = cards.join('');
    els.weatherGrid.setAttribute('aria-busy', 'false');
  }

  function updateWeatherHeading(dates) {
    els.weatherSubtitle.textContent = 'Утро 9:00 · день 14:00 · вечер 19:00';

    const available =
      weatherStatus === 'success' && weatherData
        ? dates.map((date) => weatherData.byDate.get(date)).filter(Boolean)
        : [];

    if (available.length) {
      els.weatherSummary.hidden = false;
      els.weatherSummary.textContent = weatherSummaryText(available);
    } else {
      els.weatherSummary.hidden = true;
      els.weatherSummary.textContent = '';
    }

    if (weatherStatus === 'success' && weatherData && weatherData.fetchedAt) {
      els.weatherUpdated.hidden = false;
      els.weatherUpdated.textContent = `Обновлено в ${formatTime(weatherData.fetchedAt)}`;
    } else {
      els.weatherUpdated.hidden = true;
      els.weatherUpdated.textContent = '';
    }
  }

  function weatherSummaryText(days) {
    const temps = [];
    let windMax = 0;
    let precipDays = 0;

    days.forEach((day) => {
      day.hours.forEach((hour) => {
        if (hour && Number.isFinite(hour.temp)) temps.push(hour.temp);
      });
      if (Number.isFinite(day.windMax)) windMax = Math.max(windMax, day.windMax);
      if ((day.precipProb || 0) >= 50 || (day.precipSum || 0) >= 0.5) precipDays += 1;
    });

    const parts = [];
    if (temps.length) {
      parts.push(`Температура ${formatTemp(Math.min(...temps))}…${formatTemp(Math.max(...temps))}`);
    }
    parts.push(
      precipDays
        ? `осадки ${precipDays} ${plural(precipDays, ['день', 'дня', 'дней'])}`
        : 'без осадков'
    );
    if (windMax > 0) parts.push(`ветер до ${Math.round(windMax)} м/с`);
    return parts.join(' · ');
  }

  function weatherCardHtml(day, index) {
    const meta = weatherMeta(day.code);
    const isToday = day.date === today;
    const isTomorrow = day.date === addDays(today, 1);
    const dayLabel = isToday ? 'Сегодня' : isTomorrow ? 'Завтра' : formatWeekday(day.date);
    const labels = ['Утро', 'День', 'Вечер'];

    const times = day.hours
      .map((hour, hourIndex) => {
        if (!hour) {
          return `<div class="weather-time"><span class="weather-time__label">${labels[hourIndex]}</span><strong class="weather-time__temp">—</strong><span class="weather-time__feels">&nbsp;</span></div>`;
        }
        const feels = Number.isFinite(hour.feels)
          ? `ощущ. ${formatTemp(hour.feels)}`
          : '&nbsp;';
        return `<div class="weather-time"><span class="weather-time__label">${labels[hourIndex]}</span><strong class="weather-time__temp">${formatTemp(hour.temp)}</strong><span class="weather-time__feels">${feels}</span></div>`;
      })
      .join('');

    const wind = Number.isFinite(day.windMax) ? `до ${Math.round(day.windMax)} м/с` : '—';
    const precipParts = [];
    if (Number.isFinite(day.precipProb)) precipParts.push(`${Math.round(day.precipProb)}%`);
    if (Number.isFinite(day.precipSum) && day.precipSum > 0.05) {
      precipParts.push(`${formatDecimal(day.precipSum)} мм`);
    }
    const precip = precipParts.length ? precipParts.join(' · ') : 'без осадков';

    return `<article class="weather-card weather-card--${meta.group}" style="animation-delay:${Math.min(index * 30, 240)}ms">
      <div class="weather-card__head">
        <div>
          <span class="weather-card__day">${dayLabel}</span>
          <span class="weather-card__date">${formatDayMonth(day.date)}</span>
        </div>
        <span class="weather-card__icon" aria-hidden="true">${weatherIconHtml(weatherIconKey(day.code))}</span>
      </div>
      <p class="weather-card__desc">${meta.label}</p>
      <div class="weather-times">${times}</div>
      <div class="weather-card__footer">
        <span class="weather-metric"><svg class="icon" aria-hidden="true"><use href="#icon-wind"></use></svg>${wind}</span>
        <span class="weather-metric"><svg class="icon" aria-hidden="true"><use href="#icon-drop"></use></svg>${precip}</span>
      </div>
    </article>`;
  }

  function placeholderCardHtml(date, index) {
    const isFuture = date > addDays(today, WEATHER_FUTURE_DAYS);
    const title = isFuture ? 'Прогноз появится позже' : 'Нет данных';
    const text = isFuture ? 'Доступен на 16 дней вперёд.' : 'Для этой даты прогноза нет.';
    return `<article class="weather-card weather-card--placeholder" style="animation-delay:${Math.min(index * 30, 240)}ms">
      <span class="placeholder__icon"><svg class="icon" aria-hidden="true"><use href="#icon-clock"></use></svg></span>
      <span class="placeholder__title">${title}</span>
      <p class="placeholder__text">${formatWeekday(date)}, ${formatDayMonth(date)} · ${text}</p>
    </article>`;
  }

  function skeletonCards(count) {
    const total = Math.max(1, Math.min(count, 8));
    return Array.from({ length: total }, (_, index) => `<article class="weather-card weather-card--skeleton" aria-hidden="true">
      <div class="skeleton-head">
        <div style="flex:1">
          <span class="skeleton skeleton--title"></span>
          <span class="skeleton skeleton--date"></span>
        </div>
        <span class="skeleton skeleton--icon"></span>
      </div>
      <span class="skeleton skeleton--desc"></span>
      <span class="skeleton skeleton--row"></span>
      <span class="skeleton skeleton--footer"></span>
    </article>`).join('');
  }

  function emptyWeatherHtml(title, text) {
    return `<div class="weather-empty">
      <p class="weather-empty__text"><strong>${title}</strong><br> ${text}</p>
    </div>`;
  }

  function errorWeatherHtml(message) {
    return `<div class="weather-error">
      <p class="weather-error__text">${message}</p>
      <button class="retry-button" type="button" id="weather-retry">
        <svg class="icon" aria-hidden="true"><use href="#icon-refresh"></use></svg>
        Повторить
      </button>
    </div>`;
  }

  init();
})();
