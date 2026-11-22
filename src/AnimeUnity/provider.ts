/// <reference path="./onlinestream-provider.d.ts" />
/// <reference path="./core.d.ts" />

class Provider {

    private apiBaseUrl: string = "{{baseUrl}}"
        .replace(/^(https?:\/\/)www\./i, "$1")
        .replace(/\/+$/, "");
    private referrer: string = "{{referrer}}";
    private origin: string = "{{origin}}"
        .replace(/^(https?:\/\/)www\./i, "$1")
        .replace(/\/+$/, "");
    private userAgent: string = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    private inertiaVersion: string = "";

    getSettings(): Settings {
        return {
            episodeServers: ["Server1", "Server2", "Server3 (mp4)"],
            supportsDub: true,
        }
    }

    async search(query: SearchOptions): Promise<SearchResult[]> {
        const allTitles = [query.query, query.media?.romajiTitle, query.media?.englishTitle, ...(query.media?.synonyms ?? [])]
            .filter(Boolean) as string[];
        const smartSearch = $scannerUtils.buildSmartSearchTitles(allTitles);
        const queries = [...new Set([...smartSearch.titles, ...allTitles]
            .map(title => $scannerUtils.sanitizeQuery(title).toLowerCase().trim())
            .filter(Boolean))];
        const preferredLanguage = query.dub ? "ita" : "jpn";
        const results = new Map<string, SearchResult>();

        for (const searchQuery of queries) {
            const response = await this._makeRequest(
                `/archive?query=${encodeURIComponent(searchQuery)}`,
                "GET",
                null,
                { "Referer": `${this.apiBaseUrl}/archive` },
                "text"
            );
            if (typeof response !== "string" || !response) continue;

            const $ = LoadDoc(response);
            const pageData = $('#app').attr("data-page");
            if (!pageData) continue;

            let payload: any;
            try {
                payload = JSON.parse(pageData);
            } catch (error) {
                console.error("Could not parse archive page Inertia payload", error);
                continue;
            }

            const animes = payload?.props?.animes?.data;
            if (!Array.isArray(animes)) continue;

            for (const anime of animes) {
                if (anime?.id == null || !anime?.slug) continue;
                const variants = Array.isArray(anime.variants) ? anime.variants : [];
                const hasPreferredLanguage = variants.some((variant: any) => variant.language === preferredLanguage);
                if (variants.length > 0 && !hasPreferredLanguage) continue;

                const key = `${anime.id}-${anime.slug}`;
                if (!results.has(key)) {
                    results.set(key, {
                        id: `${key}::${preferredLanguage}`,
                        title: anime.title ?? anime.title_eng ?? anime.title_it ?? anime.slug,
                        url: `${this.apiBaseUrl}/anime/${key}`,
                        subOrDub: query.dub ? "dub" : "sub"
                    });
                }
            }
            if (results.size > 0) break;
        }

        return [...results.values()];
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const [animeKey, requestedLanguage] = id.split("::");
        const [animeId, ...slugParts] = animeKey.split("-");
        const slug = slugParts.join("-");
        const animePath = `/anime/${animeId}-${slug}`;
        const page = await this._makeRequest(animePath, "GET", null, null, "text");
        if (typeof page !== "string" || !page) {
            console.error("Failed to fetch anime page for episode list");
            return [];
        }

        const $ = LoadDoc(page);
        const pageData = $('#app').attr("data-page");
        if (!pageData) {
            console.error("Anime page is missing its Inertia data-page payload");
            return [];
        }

        let payload: any;
        try {
            payload = JSON.parse(pageData);
        } catch (error) {
            console.error("Could not parse anime page Inertia payload", error);
            return [];
        }

        this.inertiaVersion = payload?.version ?? "";
        const loadedEpisodes = payload?.props?.loadedEpisodes?.episodes;
        if (!Array.isArray(loadedEpisodes)) {
            console.error("Anime page payload does not contain loadedEpisodes.episodes");
            return [];
        }

        const language = requestedLanguage === "ita" ? "ita" : "jpn";
        return loadedEpisodes.flatMap((episode: any): EpisodeDetails[] => {
            const selectedVideo = Array.isArray(episode?.videos)
                ? episode.videos.find((video: any) => video?.language === language && video?.id != null)
                : undefined;
            if (!selectedVideo) return [];
            return [{
                id: String(selectedVideo.id),
                number: Number(episode.number) || Number(episode.seq_number_start) || 0,
                url: `${animePath}/${selectedVideo.id}`
            }];
        });
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        const server = (_server && _server !== "default") ? _server : "Server3 (mp4)";
        const episodePath = episode.url.startsWith("/") ? episode.url : `/${episode.url}`;
        const animePagePath = episodePath.split("/").slice(0, -1).join("/");
        try {
            const pageUrl = new URL(animePagePath.replace(/^\/+/, ""), `${this.apiBaseUrl}/`).toString();
            const pageResponse = await fetch(pageUrl, { headers: { "User-Agent": this.userAgent } });
            if (pageResponse.ok) {
                const pageHtml = await pageResponse.text();
                const pageData = LoadDoc(pageHtml)('#app').attr("data-page");
                if (pageData) {
                    const pagePayload = JSON.parse(pageData);
                    this.inertiaVersion = pagePayload?.version ?? this.inertiaVersion;
                }
            }
        } catch (error) {
            console.warn("Could not refresh the Inertia version before episode lookup", error);
        }
        const inertiaHeaders = {
            "Accept": "text/html, application/xhtml+xml",
            "X-Requested-With": "XMLHttpRequest",
            "X-Inertia": "true",
            "X-Inertia-Partial-Component": "Anime",
            "X-Inertia-Partial-Data": "episode,embedUrl",
            ...(this.inertiaVersion ? { "X-Inertia-Version": this.inertiaVersion } : {}),
            "Referer": `${this.apiBaseUrl}${episodePath.split("/").slice(0, -1).join("/")}`,
            "Origin": this.origin,
            "User-Agent": this.userAgent
        };

        const episodePayload = await this._makeRequest(episodePath, "GET", null, inertiaHeaders, "json") as any;
        const embedUrl = episodePayload?.props?.embedUrl;
        if (typeof embedUrl !== "string" || !embedUrl) {
            throw new Error(`No embedUrl returned for episode video ${episode.id}`);
        }

        const embedResponse = await fetch(embedUrl, {
            method: "GET",
            headers: {
                "Referer": `${this.apiBaseUrl}/`,
                "Origin": this.origin,
                "User-Agent": this.userAgent
            }
        });
        if (!embedResponse.ok) {
            throw new Error(`Embed request failed: ${embedResponse.status} ${embedResponse.statusText}`);
        }

        const embedHtml = await embedResponse.text();
        const serverKey = server.toLowerCase();
        if (serverKey === "server1" || serverKey === "server2") {
            const streamsMatch = embedHtml.match(/window\.streams\s*=\s*(\[[\s\S]*?\])\s*;/);
            if (!streamsMatch?.[1]) {
                throw new Error("Could not find window.streams in the embed page");
            }

            const streams = JSON.parse(streamsMatch[1]);
            const selectedStream = streams.find((stream: any) =>
                String(stream?.name ?? "").toLowerCase() === serverKey
            );
            if (!selectedStream?.url) {
                throw new Error(`Could not find ${server} in window.streams`);
            }

            const paramsMatch = embedHtml.match(/window\.masterPlaylist\s*=\s*\{[\s\S]*?params\s*:\s*\{([\s\S]*?)\}/);
            if (!paramsMatch?.[1]) {
                throw new Error("Could not find window.masterPlaylist.params in the embed page");
            }

            const masterParams: Record<string, string> = {};
            const paramPattern = /['"]?([A-Za-z_$][\w$]*)['"]?\s*:\s*(['"])(.*?)\2/g;
            let paramMatch: RegExpExecArray | null;
            while ((paramMatch = paramPattern.exec(paramsMatch[1])) !== null) {
                masterParams[paramMatch[1]] = paramMatch[3];
            }

            const playlistUrl = new URL(selectedStream.url);
            for (const [name, value] of Object.entries(masterParams)) {
                if (value) playlistUrl.searchParams.append(name, value);
            }
            if (new URL(embedUrl).searchParams.get("canPlayFHD")) {
                playlistUrl.searchParams.append("h", "1");
            }

            const embedOrigin = new URL(embedUrl).origin;
            return {
                server,
                headers: {
                    "Referer": embedUrl,
                    "Origin": embedOrigin,
                    "User-Agent": this.userAgent
                },
                videoSources: [{
                    quality: "auto",
                    subtitles: [],
                    type: "m3u8",
                    url: playlistUrl.toString()
                }]
            };
        }

        const downloadMatch = embedHtml.match(/window\.downloadUrl\s*=\s*['"`]([^'"`]+)['"`]/);
        if (!downloadMatch?.[1]) {
            throw new Error("Could not find window.downloadUrl in the embed page");
        }

        const downloadUrl = downloadMatch[1].replace(/\\u0026/g, "&").replace(/&amp;/g, "&");
        const videoSource: VideoSource = {
            quality: "1080p",
            subtitles: [],
            type: "mp4",
            url: downloadUrl
        };

        return {
            server,
            headers: {
                "Referer": `${this.apiBaseUrl}/`,
                "Origin": this.origin,
                "User-Agent": this.userAgent
            },
            videoSources: [videoSource]
        };
    }

    async _makeRequest(endpoint: string, method: string = "GET", body: any = null, headers: any = null, returnType: "json" | "text" = "text"): Promise<string | any> {

        try {
            if (!headers) headers = {}

            headers["User-Agent"] = this.userAgent;
            let options: RequestInit = {
                method: method,
                headers: headers,
                credentials: "include"
            }

            if (body) {
                if (method === "GET") {
                    endpoint += "?" + new URLSearchParams(body).toString()
                } else {
                    options.body = JSON.stringify(body)
                    headers["Content-Type"] = "application/json"
                }
            }
            const requestUrl = new URL(endpoint.replace(/^\/+/, ""), `${this.apiBaseUrl}/`).toString();
            let response = await fetch(requestUrl, options)
            const getInertiaLocation = (result: any): string => {
                const value = result?.headers?.["X-Inertia-Location"]
                    ?? result?.headers?.["x-inertia-location"]
                    ?? result?.headers?.["X-INERTIA-LOCATION"];
                return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
            };
            let inertiaLocation = getInertiaLocation(response);
            if (response.status === 409 && inertiaLocation) {
                const locationUrl = new URL(inertiaLocation, `${this.apiBaseUrl}/`).toString();
                const freshPageResponse = await fetch(locationUrl, {
                    method: "GET",
                    headers: {
                        "Accept": "text/html, application/xhtml+xml",
                        "User-Agent": this.userAgent,
                        "Referer": `${this.apiBaseUrl}/`
                    }
                });

                if (!freshPageResponse.ok) {
                    throw new Error(`Failed to fetch X-Inertia-Location page: HTTP ${freshPageResponse.status}`);
                }

                const freshPageHtml = await freshPageResponse.text();
                const freshPageData = LoadDoc(freshPageHtml)('#app').attr("data-page");
                if (!freshPageData) {
                    throw new Error("X-Inertia-Location page did not contain an app data-page payload");
                }

                const freshPagePayload = JSON.parse(freshPageData);
                const freshVersion = freshPagePayload?.version;
                if (!freshVersion) {
                    throw new Error("X-Inertia-Location page did not contain an Inertia version");
                }

                this.inertiaVersion = freshVersion;
                const retryHeaders = { ...headers, "X-Inertia-Version": freshVersion };
                response = await fetch(requestUrl, { ...options, headers: retryHeaders });
                inertiaLocation = getInertiaLocation(response) || inertiaLocation;
            }
            if (!response.ok) {
                const responseBody = response.status === 409 ? (await response.text()).slice(0, 500) : "";
                throw new Error(`HTTP error! status: ${response.status}${inertiaLocation ? `; X-Inertia-Location: ${inertiaLocation}` : ""}${responseBody ? `; response: ${responseBody}` : ""}`);
            }

            if (returnType === "text") return await response.text();

            return await response.json()
        }
        catch (error: any) {
            console.error(error);
        }
    }

    async _getAnimeEpisodes(start: number, end: number, animeId: string | number, slug: string, episodeLimitForIteration: number = 120): Promise<EpisodeDetails[]> {

        const episodes: EpisodeDetails[] = [];
        let current = start;
        let endRange = Math.min(start + episodeLimitForIteration, end);

        console.log(`START - Current: ${current} - endRange: ${endRange}`);

        while (current < end) {
            let response = await this._makeRequest(`/info_api/${animeId}/0?start_range=${current + 1}&end_range=${endRange}`, "GET", null, null, "json");

            let returnedEpisoeds: EpisodeDetails[] = response.episodes.map((episode: any, index: number): EpisodeDetails => (
                {
                    id: episode.id.toString(),
                    number: Number(episode.number) ?? index + 1,
                    url: `embed-url/${episode.id.toString()}`
                }
            ));

            episodes.push(...returnedEpisoeds);
            current = endRange;
            endRange = Math.min(current + episodeLimitForIteration, end);

            console.log(`WHILE - Current: ${current} - endRange: ${endRange}`);
        }

        if(episodes.length === 0){
            // Fallback to the main episode page
            let response = await this._makeRequest(`/anime/${animeId}-${slug}`, "GET", null, null, "text");
            if(!response){
                console.error("Failed to fetch episode page for fallback");
                return [];
            }
            let $ = LoadDoc(response);
            let videoPlayerElement = $('video-player');
            let episodesJson = videoPlayerElement.attr("episodes");
            if (!episodesJson) {
                console.error("Failed to extract anime data from video player for fallback");
                return [];
            }
            console.log("Found anime data in video player, using it for fallback episode list");
            episodesJson = JSON.parse(episodesJson);

            if(episodesJson && Array.isArray(episodesJson)){
                console.log("Episodes found in video player data for fallback:", episodesJson.length);
                episodesJson.forEach((episode: any) => {
                    episodes.push({
                        id: episode['id'].toString(),
                        number: Number(episode.number),
                        url: `embed-url/${episode['id'].toString()}`
                    });
                });
            }
        }

        return episodes;
    }

    _sanitizeTitle(title: string): string {
        console.log(`Sanitizing title: "${title}"`);
        return title.toLowerCase()
            .split(/[\-_:]+/)[0]
            .replace(/\s+/g, " ")
            .trim();
    }
}
