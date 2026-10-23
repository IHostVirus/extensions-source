(() => {
    "use strict";

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (check, { timeoutMs = 30000, intervalMs = 250 } = {}) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            let value = null;
            try { value = check(); } catch (e) { value = null; }
            if (value) return value;
            if (Date.now() >= deadline) return null;
            await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
        }
    };
    const waitForStable = async (probe, { timeoutMs = 30000, intervalMs = 300, stableRounds = 2 } = {}) => {
        const deadline = Date.now() + timeoutMs;
        let lastSignature = null;
        let stable = 0;
        let value = null;
        while (Date.now() < deadline) {
            value = probe();
            const signature = JSON.stringify(value);
            if (signature === lastSignature) {
                if (++stable >= stableRounds) return value;
            } else {
                stable = 0;
                lastSignature = signature;
            }
            await sleep(intervalMs);
        }
        return value;
    };
    const readInitialData = (doc) => {
        const candidates = [];
        const byId = doc.querySelector("script#initial-data");
        if (byId) candidates.push(byId);
        for (const script of doc.querySelectorAll('script[type="application/json"]')) {
            if (script !== byId) candidates.push(script);
        }
        for (const script of candidates) {
            try {
                const data = JSON.parse(script.textContent || "null");
                if (data && typeof data === "object") return data;
            } catch (e) {  }
        }
        return null;
    };
    const walkJson = (data, visit, maxDepth = 12) => {
        const stack = [[data, 0]];
        while (stack.length) {
            const [value, depth] = stack.pop();
            visit(value, depth);
            if (depth >= maxDepth || !value || typeof value !== "object") continue;
            const children = Array.isArray(value) ? value : Object.values(value);
            for (let i = children.length - 1; i >= 0; i--) stack.push([children[i], depth + 1]);
        }
    };
    const CHAPTER_PATH = /^\/title\/([a-z0-9]+)-[^/]+\/(\d+)-chapter-(\d+(?:\.\d+)?)/i;
    const IMAGE_EXT = /\.(?:jpe?g|png|webp|avif|gif)$/i;
    const pathOf = (href) => {
        if (!href) return "";
        if (/^https?:\/\//i.test(href)) {
            try { return new URL(href).pathname; } catch (e) { return href; }
        }
        return href.split(/[?#]/)[0];
    };
    const parseChapterPath = (path) => {
        const match = CHAPTER_PATH.exec(path || "");
        return match ? { hid: match[1], id: Number(match[2]), number: parseFloat(match[3]) } : null;
    };
    const imageSrc = (img) => {
        const src = img.getAttribute("src") || "";
        const lazy = img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || "";
        if (lazy && (!src || src.startsWith("data:"))) return lazy;
        return src || lazy || null;
    };

    const OPTIONS = Object.assign(
        { timeoutMs: 30000, pollMs: 300, stableRounds: 3 },
        window.__comixHarvestOptions || {});

    const NON_CONTENT = /avatar|icon|logo|emoji|emoticon|sprite|placeholder|blank|loading|spinner|profile|userpic|favicon/i;

    // The reader asks the site's own chapter API for its pages, so take them from that response
    const API_PATH = /^\/api\/v1\/chapters\/[^/]+\/?$/;
    const apiState = { pages: null };
    const isPages = (value) => value &&
        Array.isArray(value.items) &&
        value.items.length > 0 &&
        value.items.every((item) => item && typeof item.url === "string");
    const findPages = (data) => {
        let best = null;
        walkJson(data, (value) => {
            if (!value || typeof value !== "object") return;
            const candidate = Array.isArray(value) ? { items: value } : value;
            if (isPages(candidate) && (!best || candidate.items.length > best.items.length)) best = candidate;
        }, 6);
        return best;
    };
    const onApiData = (data) => {
        const pages = findPages(data);
        if (pages) apiState.pages = pages;
    };
    const apiUrls = (pages) => {
        const base = typeof pages.baseUrl === "string" ? pages.baseUrl.replace(/\/+$/, "") : "";
        const urls = [];
        for (const item of pages.items) {
            let url;
            try {
                url = /^https?:\/\//i.test(item.url) || !base
                    ? new URL(item.url, location.href).href
                    : base + "/" + item.url.replace(/^\/+/, "");
            } catch (e) { continue; }
            if (item.s === 1 && !/[?&]v3(?:[=&]|$)/.test(url)) url += (url.includes("?") ? "&" : "?") + "v3";
            urls.push(url);
        }
        return urls;
    };

    // What the page's API calls returned, shown in the error when no pages are found
    const debug = { reqs: [] };
    const apiPathOf = (url) => {
        try { return new URL(String(url), location.href).pathname; } catch (e) { return ""; }
    };
    const track = (path, entry, text) => {
        if (debug.reqs.length < 8) debug.reqs.push(entry);
        if (API_PATH.test(path) && typeof text === "string") {
            entry.b = text.slice(0, 160);
            try { onApiData(JSON.parse(text)); } catch (e) { entry.parse = "fail"; }
        }
    };

    const originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
        window.fetch = function (input) {
            const promise = originalFetch.apply(this, arguments);
            try {
                const url = typeof input === "string" ? input : (input && input.url) || String(input);
                const path = apiPathOf(url);
                if (path.startsWith("/api/")) {
                    promise.then((response) => {
                        const entry = { p: path.slice(0, 50), st: response.status };
                        if (!API_PATH.test(path)) return track(path, entry);
                        try { response.clone().text().then((text) => track(path, entry, text), () => track(path, entry)); } catch (e) { track(path, entry); }
                    }, (error) => track(path, { p: path.slice(0, 50), err: String(error).slice(0, 60) }));
                }
            } catch (e) {  }
            return promise;
        };
    }
    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
        const originalOpen = XHR.prototype.open;
        XHR.prototype.open = function (method, url) {
            try { this.__comixUrl = String(url); } catch (e) {  }
            return originalOpen.apply(this, arguments);
        };
        const originalSend = XHR.prototype.send;
        XHR.prototype.send = function () {
            try {
                const path = apiPathOf(this.__comixUrl);
                if (path.startsWith("/api/")) {
                    this.addEventListener("loadend", () => {
                        const entry = { p: path.slice(0, 50), st: this.status, x: 1 };
                        let text;
                        try {
                            text = this.responseType === "json" ? JSON.stringify(this.response) : this.responseText;
                        } catch (e) {  }
                        track(path, entry, text);
                    });
                }
            } catch (e) {  }
            return originalSend.apply(this, arguments);
        };
    }

    const collect = () => {
        const urls = [];
        for (const img of Array.from(document.querySelectorAll("img"))) {
            const src = imageSrc(img);
            if (!src || src.startsWith("data:")) continue;
            if (!IMAGE_EXT.test(pathOf(src))) continue;
            if (NON_CONTENT.test(src)) continue;

            const w = img.naturalWidth || img.width || 0;
            const h = img.naturalHeight || img.height || 0;
            if (w > 0 && h > 0 && w < 200 && h < 200) continue;
            if (!urls.includes(src)) urls.push(src);
        }
        return urls;
    };

    const pageSnapshot = () => {
        const imgs = Array.from(document.querySelectorAll("img"));
        const text = ((document.body && document.body.innerText) || "").replace(/\s+/g, " ").trim();
        return {
            path: location.pathname,
            ready: document.readyState,
            title: String(document.title || "").slice(0, 60),
            img: imgs.length,
            canvas: document.querySelectorAll("canvas").length,
            iframe: document.querySelectorAll("iframe").length,
            src: imgs.slice(0, 3).map((img) => String(imageSrc(img) || "").slice(0, 70)),
            text: text.slice(0, 120),
            reqs: debug.reqs,
        };
    };

    const nudgeScroll = () => {
        try { window.scrollBy(0, Math.floor((window.innerHeight || 600) * 0.8)); } catch (e) {  }
    };

    const harvest = async () => {
        const here = parseChapterPath(location.pathname || pathOf(location.href || ""));
        const data = readInitialData(document);

        const corroborated = { chapterId: false, mangaHid: false };
        if (data && here) {
            walkJson(data, (value) => {
                if (value === here.id) corroborated.chapterId = true;
                if (value === here.hid) corroborated.mangaHid = true;
            });
        }

        // The host gives up 30s after the data request, so stop waiting before that
        const waitMs = Math.min(OPTIONS.timeoutMs, 25000);
        await waitFor(() => apiState.pages || collect().length > 0 || null,
            { timeoutMs: waitMs, intervalMs: OPTIONS.pollMs });

        let images;
        let source;
        if (apiState.pages) {
            images = apiUrls(apiState.pages);
            source = "api";
        } else {
            images = collect();
            source = "dom";
            if (images.length) {
                images = await waitForStable(() => { nudgeScroll(); return collect(); },
                    { timeoutMs: Math.min(OPTIONS.timeoutMs, 10000), intervalMs: OPTIONS.pollMs, stableRounds: OPTIONS.stableRounds }) || images;
            }
        }

        return {
            page: "read",
            chapterId: here ? here.id : null,
            mangaHid: here ? here.hid : null,
            chapterNumber: here ? here.number : null,
            corroborated,
            source,
            debug: images.length ? null : pageSnapshot(),
            count: images.length,
            images,
        };
    };

    const done = (result) => {
        window.__comixHarvest = result;
        console.log("[comix-harvest:pages] " + JSON.stringify(result));
    };
    window.__comixHarvestPromise = (async () => {
        try {
            const result = await harvest();
            done(result);
            return result;
        } catch (e) {
            const result = { page: "read", error: String((e && e.message) || e), images: [], count: 0 };
            done(result);
            return result;
        }
    })();
})();
