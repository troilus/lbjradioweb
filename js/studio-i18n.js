/* UV Studio shared internationalization runtime.
   Chinese only: the language switcher was removed, so this runtime always
   renders the zh dictionary. Local JavaScript dictionaries keep index.html
   file:// friendly. */
;(function () {
    "use strict";

    const dictionaries = window.UVSTUDIO_LOCALES || {};

    function interpolate(template, values) {
        let result = String(template);
        if (values.length === 1 && values[0] && typeof values[0] === "object" && !Array.isArray(values[0])) {
            Object.entries(values[0]).forEach(([name, value]) => {
                result = result.split(`{${name}}`).join(String(value));
            });
            return result;
        }
        values.forEach((value, index) => {
            result = result.split(`{${index}}`).join(String(value));
        });
        return result;
    }

    const i18n = {
        lang: "zh",
        dict: dictionaries.zh || {},

        t(key, ...values) {
            const template = this.dict[key] !== undefined ? this.dict[key] : key;
            return interpolate(template, values);
        },

        apply(root) {
            const scope = root || document;
            scope.querySelectorAll("[data-i18n]").forEach(element => {
                element.textContent = this.t(element.getAttribute("data-i18n"));
            });
            scope.querySelectorAll("[data-i18n-title]").forEach(element => {
                const key = element.getAttribute("data-i18n-title");
                if (key) element.setAttribute("title", this.t(key));
            });
            scope.querySelectorAll("[data-i18n-aria-label]").forEach(element => {
                const key = element.getAttribute("data-i18n-aria-label");
                if (key) element.setAttribute("aria-label", this.t(key));
            });
            scope.querySelectorAll("[data-i18n-placeholder]").forEach(element => {
                const key = element.getAttribute("data-i18n-placeholder");
                if (key) element.setAttribute("placeholder", this.t(key));
            });
        },

        // Kept for callers that used to switch languages; this page is
        // Chinese-only now, so it just re-renders the Chinese dictionary.
        setLanguage(language, options) {
            const settings = Object.assign({ announce: true }, options);
            this.lang = "zh";
            this.dict = dictionaries.zh || {};
            document.documentElement.lang = "zh";

            this.apply(document);
            if (settings.announce) {
                window.dispatchEvent(new CustomEvent("uvstudio:languagechange", {
                    detail: { lang: this.lang }
                }));
            }
        },

        init() {
            this.setLanguage("zh", { announce: false });

            window.dispatchEvent(new CustomEvent("i18n:ready", {
                detail: { lang: this.lang }
            }));
        }
    };

    window.uvStudioI18n = i18n;
    try {
        i18n.init();
        window.uvStudioI18nReady = Promise.resolve(i18n);
    } catch (error) {
        console.error("UV Studio i18n initialization failed:", error);
        window.uvStudioI18nReady = Promise.resolve(i18n);
    }
})();
