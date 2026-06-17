/**
 * @fileoverview
 * Utility function to detect locale from a parameter on the URL.
 */

import queryString from 'query-string';

/**
 * Resolve the locale strictly from the URL, mirroring the embedding platform's
 * URL-based localization (Paraglide's "url" -> "baseLocale" strategy): the
 * `?locale=`/`?lang=` query param wins, otherwise we default to English.
 *
 * We deliberately do NOT fall back to the browser/region locale
 * (`navigator.language`). The editor is embedded as an iframe whose `?locale=`
 * is set from the parent page's URL, so the editor must follow that URL — not
 * the visitor's browser language — to stay in sync with the rest of the page.
 * @param {Array.string} supportedLocales An array of supported locale codes.
 * @return {string} the preferred locale
 */
const detectLocale = supportedLocales => {
    const queryParams = queryString.parse(location.search);
    // Flatten potential arrays and remove falsy values
    const potentialLocales = [].concat(queryParams.locale, queryParams.lang).filter(l => l);
    if (potentialLocales.length) {
        const urlLocale = potentialLocales[0].toLowerCase();
        if (supportedLocales.includes(urlLocale)) {
            return urlLocale;
        }
    }

    return 'en'; // default
};

export {
    detectLocale
};
