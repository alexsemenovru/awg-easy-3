'use strict';

window.awgGeoClient = (() => {
  const fold = value => value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
  const catalog = (codes, language) => {
    const names = new Intl.DisplayNames([language], { type: 'region' });
    const aliases = ['en', 'ru', 'es', 'fa', 'zh-cn'].map(locale => new Intl.DisplayNames([locale], { type: 'region' }));
    return [...new Set(codes)].filter(code => /^[A-Z]{2}$/.test(code))
      .map(code => ({ code, name: names.of(code) || code, aliases: aliases.map(provider => provider.of(code)) }))
      .sort((a, b) => a.name.localeCompare(b.name, language));
  };
  const resolve = (text, entries) => {
    const tokens = text.split(/[,،，]/).map(fold).filter(Boolean);
    if (!tokens.length) throw new Error('geoChooseCountry');
    const codes = tokens.map(token => {
      const matches = entries.filter(entry => [entry.name, entry.code, ...(entry.aliases || [])].some(name => fold(name) === token));
      if (matches.length !== 1) throw new Error('geoUnknownCountry');
      return matches[0].code;
    });
    return [...new Set(codes)].sort();
  };
  const attach = ({ node, client, codes, language, t, save }) => {
    const form = node.querySelector('.geo-form');
    const mode = form.querySelector('.geo-mode');
    const input = form.querySelector('.geo-countries');
    const suggestions = form.querySelector('datalist');
    const button = form.querySelector('button');
    const message = form.querySelector('.geo-message');
    const currentLanguage = () => typeof language === 'function' ? language() : language;
    let entries = catalog(codes(), currentLanguage());
    const policy = client.geoPolicy || { mode: 'off', countries: [] };
    mode.value = policy.mode;
    input.value = policy.countries.map(code => entries.find(entry => entry.code === code)?.name || code).join(', ');
    suggestions.id = `geo-countries-${client.id}`;
    input.setAttribute('list', suggestions.id);
    const options = () => {
      entries = catalog(codes(), currentLanguage());
      const parts = input.value.split(/[,،，]/);
      const needle = fold(parts.pop() || '');
      const prefix = parts.length ? `${parts.join(',').trim()}, ` : '';
      suggestions.replaceChildren(...entries.filter(entry => !needle || fold(entry.name).includes(needle)
        || fold(entry.code).startsWith(needle)).slice(0, 20).map(entry => {
        const option = document.createElement('option');
        option.value = `${prefix}${entry.name}`;
        option.label = entry.code;
        return option;
      }));
    };
    const state = () => { input.disabled = mode.value === 'off'; options(); };
    input.addEventListener('input', options);
    mode.addEventListener('change', state);
    state();
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (button.disabled) return;
      message.textContent = '';
      delete message.dataset.i18n;
      let countries;
      entries = catalog(codes(), currentLanguage());
      try { countries = mode.value === 'off' ? [] : resolve(input.value, entries); }
      catch (error) { message.dataset.i18n = error.message; message.textContent = t(error.message); return; }
      button.disabled = true; mode.disabled = true; input.disabled = true;
      try { await save({ mode: mode.value, countries }); }
      catch (error) {
        if (error.code === 'GEO_UNAVAILABLE') message.dataset.i18n = 'GEO_UNAVAILABLE';
        message.textContent = error.code === 'GEO_UNAVAILABLE' ? t('GEO_UNAVAILABLE') : error.message;
      }
      finally { button.disabled = false; mode.disabled = false; state(); }
    });
  };
  return { catalog, resolve, attach };
})();
