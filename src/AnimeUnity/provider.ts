/// <reference path="./onlinestream-provider.d.ts" />
/// <reference path="./core.d.ts" />

class Provider {

    private apiBaseUrl: string = "https://animeunity.top";
    private cookies: string = "";
    private csrfToken: string = "";
    private cookiesExpirationDate: Date | null = null;
    
    // --- Public Methods ---

    getSettings(): Settings {
        return {
            episodeServers: ["Server1", "Server2"],
            supportsDub: true,
        }
    }

    async search(query: SearchOptions): Promise<SearchResult[]> {
        const normalizedUrl = this.apiBaseUrl.toLowerCase();
        // Conditional Check for .top domain
        if (normalizedUrl.includes("animeunity.top")) {
            return this._searchAnimeUnityTop(query);
        } else {
            
            return this._searchAnimeUnitySo(query);
        }
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const normalizedUrl = this.apiBaseUrl.toLowerCase();
        // Conditional Check for .top domain
        if (normalizedUrl.includes("animeunity.top")) {
            return this._findEpisodesAnimeUnityTop(id);
        } else {
            
            return this._findEpisodesAnimeUnitySo(id);
        }
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        let server = "Server1";
        if (_server !== "default") server = _server;

        const normalizedUrl = this.apiBaseUrl.toLowerCase();
        // Conditional Check for .top domain
        if (normalizedUrl.includes("animeunity.top")) {
            return this._findEpisodeServerAnimeUnityTop(episode, server);
        } else {
            
            return this._findEpisodeServerAnimeUnitySo(episode, server);
        }
    }
    
    // --- New AnimeUnity.TOP Scrapers (Regex Scraping & Season Filtering) ---

    async _searchAnimeUnityTop(query: SearchOptions): Promise<SearchResult[]> {
        const queryText = query['query'] ?? query.media.englishTitle ?? query.media.romajiTitle;
        if (!queryText) return [];

        const url = `${this.apiBaseUrl}/?story=${encodeURIComponent(queryText)}&do=search&subaction=search`;
        console.log(`Searching AU.TOP with: ${url}`);
        
        const response = await fetch(url);
        
        if (!response.ok) {
            console.error(`AU.TOP Search Failed: HTTP status ${response.status}`);
            return [];
        }
        
        let html: string;
        try {
            html = await response.text();
        } catch (e) {
            console.error(`AU.TOP Search Failed: Could not read response body as text. Error: ${e}`);
            return [];
        }

        if (typeof html !== 'string' || html.trim().length === 0) {
            console.error("AU.TOP Search Failed: Received non-string or empty content.");
            return [];
        }
        
        const results: SearchResult[] = [];
        
        // Extract the intended season from the query to encode in the ID
        const targetSeason = this._extractTargetSeason(queryText);
        
        // Regex to find the link and title from the last anchor tag in the block
        // Captures: 1. URL 2. Title Text
        const regex = /<a href="([^"]+)" class="title"[^>]*>([^<]+)<\/a>/gi;
        let match;

        while ((match = regex.exec(html)) !== null) {
            const link = match[1];
            const title = match[2].trim();

            if (link && title) {
                // Extract a unique identifier for the ID
                const slug = link.match(/\/anime\/(\d+-[^\/]+)/)?.[1] || title.toLowerCase().replace(/\s/g, '-');
                
                // Encode the target season into the ID so findEpisodes knows what to filter
                const finalId = targetSeason > 1 ? `${slug}-S${targetSeason}` : slug;

                results.push({
                    id: finalId,
                    title: title,
                    url: link,
                    subOrDub: query.dub ? 'dub' : 'sub' 
                });
            }
        }
        
        console.log(`Found ${results.length} results on AU.TOP via Regex (Target Season: ${targetSeason})`);
        return results;
    }

    async _findEpisodesAnimeUnityTop(id: string): Promise<EpisodeDetails[]> {
        // Extract the target season from the encoded ID (defaults to 1 if not present)
        const targetSeason = this._extractTargetSeason(id);
        
        // Remove the encoded season tag (-S[N]) from the ID before building the URL
        const animeSlug = id.split('-S')[0];
        const animePageUrl = `${this.apiBaseUrl}/anime/${animeSlug}.html`; 
        
        console.log(`Fetching episodes from ${animePageUrl} (Filtering for Season ${targetSeason})`);
        
        const response = await fetch(animePageUrl);
        
        if (!response.ok) {
            console.error(`AU.TOP Episode Fetch Failed: HTTP status ${response.status}`);
            return [];
        }

        let html: string;
        try {
            html = await response.text();
        } catch (e) {
            console.error(`AU.TOP Episode Fetch Failed: Could not read response body. Error: ${e}`);
            return [];
        }

        if (typeof html !== 'string' || html.trim().length === 0) {
            console.error("AU.TOP Episode Fetch Failed: Received non-string or empty content.");
            return [];
        }

        const episodes: EpisodeDetails[] = [];
        
        // Regex to find episode links within the #episodes container.
        // Captures: 1. data-link URL; 2. Season Num; 3. Episode Num
        const regex = /data-link="([^"]+)"[^>]*data-num="(\d+)x(\d+)"/gi;
        let match;

        while ((match = regex.exec(html)) !== null) {
            const dataLink = match[1];
            const seasonNum = Number(match[2]); 
            const episodeNum = Number(match[3]); 

            if (dataLink) {
                
                // Crucial Check: Only include episodes that match the target season
                if (seasonNum === targetSeason) {
                    // Episode ID is based on the final part of the dataLink + season/episode info
                    const episodeId = `${dataLink.split('/').pop()!}-${seasonNum}x${episodeNum}`;

                    episodes.push({
                        id: episodeId,
                        number: episodeNum, 
                        season: seasonNum,
                        url: dataLink // This is the Supervideo embed link
                    });
                }
            }
        }

        if (episodes.length === 0) {
            console.error(`No episodes found for Season ${targetSeason} on the anime page.`);
        }

        return episodes;
    }
    
    async _findEpisodeServerAnimeUnityTop(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        // Here, episode.url holds the data-link value (e.g., https://supervideo.cc/y/u6tyw8e90qdi)
        const embedUrl = episode.url; 
        console.log(`Fetching embed HTML from: ${embedUrl}`);
        
        const response = await fetch(embedUrl);

        if (!response.ok) {
            console.error(`AU.TOP Embed Fetch Failed: HTTP status ${response.status}. URL: ${embedUrl}`);
            throw new Error(`Embed Fetch Failed: Status ${response.status}`); 
        }
        const embedHtml = await response.text();
        
        let packedScript: string | null = null;

        // 1. Find the packed script using a more robust regex that handles variations in the inner function body.
        const supervideoPackedRegex = /(eval\(function\(p,a,c,k,e,d\){[\s\S]*?\}\s*\([\s\S]*?split\('\|'\)\s*\)\))/i;

        const match = embedHtml.match(supervideoPackedRegex);
        
        if (match && match[1]) {
            packedScript = match[1];
            console.log("Found packed script."); 
        } else {
            console.error("Could not find the packed JavaScript in the embed page. Content length: " + embedHtml.length);
            throw new Error("Could not find the packed JavaScript in the embed page.");
        }

        // 2. Unpack the script
        const unpackedScript = this._unpackPacker(packedScript);
        console.log("Script successfully unpacked.");

        // 3. Extract the M3U8 URL from the unpacked script
        const m3u8Match = unpackedScript.match(/https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*/i);
        
        if (!m3u8Match) {
            console.error("Unpacked script did not contain an M3U8 URL. Unpacked content size: " + unpackedScript.length);
            throw new Error("M3U8 URL not found in unpacked script.");
        }

        const m3u8Url = m3u8Match[0];
        console.log("Found M3U8 URL: " + m3u8Url); 
        
        const videoSources: VideoSource[] = [{
            quality: 'auto', 
            subtitles: [],
            type: 'm3u8',
            url: m3u8Url
        }];

        const serverResult: EpisodeServer = {
            server: server, 
            headers: {
                
                "Referer": embedUrl 
            },
            videoSources: videoSources
        }
        
        if (videoSources.length === 0) {
             // This should ideally never be hit if m3u8Match was successful, but kept for safety.
             throw new Error("Video sources list is empty after extraction.");
        }

        return serverResult;
    }
    
    // --- Helper Methods (New Season Extractor) ---
    
    _extractTargetSeason(queryOrId: string): number {
        // Check for patterns like "Season 2", "S2", "s02", etc.
        const match = queryOrId.match(/season\s*(\d+)|s(\d+)/i);
        if (match) {
            // match[1] captures the number from "Season 2". match[2] captures the number from "S2".
            return Number(match[1] || match[2]) || 1; 
        }
        // If no season is specified in the query/ID, default to Season 1.
        return 1;
    }

    // --- Core Supervideo Unpacker Utility ---
    
    _unpackPacker(code: string): string {
        const re =
            /eval\(function\(p,a,c,k,e,d\)\{[\s\S]+?\}\(\s*(['"])([\s\S]+?)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])([\s\S]+?)\5\.split\('\|'\)\s*\)\)/;

        const m = code.match(re);
        if (!m) {
            console.error("Input was not a recognized Dean Edwards packed script.");
            throw new Error("Not a Dean Edwards packed script");
        }

        let p = m[2];
        const a = parseInt(m[3], 10);
        let c = parseInt(m[4], 10);
        const k = m[6].split("|");

        function baseN(num: number, base: number): string {
            return num.toString(base);
        }

        while (c--) {
            if (k[c]) {
                const r = new RegExp(`\\b${baseN(c, a)}\\b`, "g"); 
                p = p.replace(r, k[c]);
            }
        }
        return p;
    }


    // --- Original AnimeUnity.SO Scrapers (API-Based) ---

    async _searchAnimeUnitySo(query: SearchOptions): Promise<SearchResult[]> {
        // Original search logic
        let response: any;
        let jsonData: any[] = [];
        let data: any[] = [];

        const validNames = [query['query'], query.media.englishTitle, query.media.romajiTitle, ...query.media.synonyms];

        for (let validName of validNames) {

            const validNameWithoutSeasonWord = validName?.toLowerCase().replace("season", "").replace(/\s+/g, " ");
            console.log(`Trying to find a match with ${validNameWithoutSeasonWord}`);

            response = await this._makeRequest('/archivio', "GET", { title: validNameWithoutSeasonWord }, null, "text");
            
            let $ = LoadDoc(response); 
            jsonData = JSON.parse($('archivio').attr('records') || '[]');

            if (jsonData.length === 0) {
                console.log("No records found. Normalizing query and retrying");
                let normalizedQuery = this._normalizeQuery(validName ?? '');
                console.log("NORMALIZED QUERY", normalizedQuery);
                response = await this._makeRequest('/archivio', "GET", { title: normalizedQuery }, null, "text");

                $ = LoadDoc(response);
                jsonData = JSON.parse($('archivio').attr('records') || '[]');

                if (jsonData.length === 0) continue;
            };

            const animeId = query.media.id;

            data = jsonData.filter((x: any) => x?.anilist_id == animeId && x.dub == query.dub);

            if (data.length !== 0) break;

            $sleep(200);
        }

        console.log("Anime found");

        let finalResults: SearchResult[] = data.map((item: any): SearchResult => (
            {
                id: `${item.id.toString()}-${item.slug}`,
                title: item.title ?? item.title_eng ?? item.title_it,
                url: `${this.apiBaseUrl}/anime/${item.id.toString()}-${item.slug}`,
                subOrDub: item.dub == 1 ? 'dub' : 'sub'
            }
        ));

        return finalResults;
    }
    
    async _findEpisodesAnimeUnitySo(id: string): Promise<EpisodeDetails[]> {
        // Original findEpisodes logic
        const animeId = id.split('-')[0];
        let response = await this._makeRequest(`/info_api/${animeId}/0`, "GET", null, null, "json");
        let episodesAmount = response["episodes_count"];
        const episodes = await this._getAnimeEpisodes(0, episodesAmount, animeId);

        return episodes;
    }

    async _findEpisodeServerAnimeUnitySo(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        // Original findEpisodeServer logic
        if (server !== "default") server = server

        let embedUrl = await this._makeRequest(episode.url, "GET", null, null, "text");

        let response = await fetch(embedUrl);

        if (!response.ok) {
            console.error("An error occured during the embed scraping. Error: " + response.statusText);
            throw new Error(response.statusText);
        }
        const embedHtml = await response.text();

        let playlistStreams: any = [];
        let masterPlaylist: any;

        if (embedHtml.includes('window.masterPlaylist')) {
            let match = embedHtml.match(/window\.masterPlaylist\s*=\s*({[\s\S]*?}\s)/s);
            if (match) {
                let jsCode = `window = {}; window.masterPlaylist = ${match[1]}; return window.masterPlaylist;`;
                masterPlaylist = new Function(jsCode)();
                console.log(masterPlaylist);
            }
        }

        if (embedHtml.includes('window.streams')) {
            let match = embedHtml.match(/window\.streams\s*=\s*(\[[\s\S]*?\]);/s);
            if (match) {
                let jsCode = `window = {}; window.streams = ${match[1]}; return window.streams;`;
                playlistStreams = new Function(jsCode)();
                console.log(playlistStreams);
            }
        }

        //GET Playlist urls
        let streamEntry = playlistStreams.filter((stream: any) => stream.name.toLowerCase() == server.toLowerCase());
        
        if (streamEntry.length === 0) {
             throw new Error(`Server '${server}' not found in stream list.`);
        }

        let playlistUrl = streamEntry[0]["url"].replace("\u0026", "&");
        playlistUrl = `${playlistUrl}&token=${masterPlaylist.params.token}&expires=${masterPlaylist.params.expires}&h=1`;

        response = await fetch(playlistUrl);
        let playlistContent = await response.text();

        const lines: string[] = playlistContent.split('\n').map((line: any) => line.trim()).filter(line => line !== '');
        const streams: any[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (line.startsWith('#EXT-X-STREAM-INF')) {
                const match = line.match(/RESOLUTION=(\d+x\d+)/);
                const resolution = match ? match[1] : 'Unknown';

                const url = lines[i + 1] || '';

                streams.push({
                    resolution: resolution.split('x')[1] + 'p',
                    url: url
                });
            }
        }

        const videoSources: VideoSource[] = streams.map((stream: any): VideoSource => ({

            quality: stream.resolution,
            subtitles: [],
            type: stream.url.includes('playlist') ? 'm3u8' : 'mp4',
            url: stream.url

        }));

        const serverResult: EpisodeServer = {
            server: server,
            headers: {},
            videoSources: videoSources
        }

        return serverResult;
    }

    // --- Common Helper Methods ---

    async _updateCookies(): Promise<void> {
        let now: Date = new Date();

        if (this.cookiesExpirationDate == null || this.cookiesExpirationDate < now) {
            try {
                let response = await fetch(this.apiBaseUrl, { method: "GET", credentials: "include" });

                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

                // Use bracket notation access for headers to resolve TypeError
                let headersJson = JSON.parse(JSON.stringify(response.headers));
                let cookies: string = headersJson["Set-Cookie"] || "";
                
                if (cookies) {
                    let cookiesParts: string[] = cookies.split(";").map(p => p.trim());
                    let expirationDateString: string = cookiesParts.find((p: string) => p.toLowerCase().startsWith("expires="))?.split("Expires=")[1].split(";")[0].trim() || "";
                    this.cookiesExpirationDate = new Date(expirationDateString);
                    this.cookies = cookiesParts.find((p: string) => p.toLowerCase().startsWith("xsrf-token=") ? p.trim() : "") || "";
                }
            }
            catch (error: any) {
                console.error(error);
            }
        }
    }

    async _makeRequest(endpoint: string, method: string = "GET", body: any = null, headers: any = null, returnType: "json" | "text" = "text"): Promise<string | any> {
        // Original _makeRequest logic
        try {
            await this._updateCookies();

            if (!headers) headers = {}

            if (this.cookies) headers["Cookie"] = this.cookies
            if (this.csrfToken) headers["X-CSRF-TOKEN"] = this.csrfToken;
            headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
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
            // Ensure the endpoint starts with a single slash if apiBaseUrl does not end with one
            const url = `${this.apiBaseUrl.replace(/\/$/, '')}/${endpoint.replace(/^\//, '')}`;
            let response = await fetch(url, options)

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)

            if (returnType === "text") return await response.text();

            return await response.json()
        }
        catch (error: any) {
            console.error(error);
        }
    }

    async _getAnimeEpisodes(start: number, end: number, animeId: string | number, episodeLimitForIteration: number = 120): Promise<EpisodeDetails[]> {
        // Original _getAnimeEpisodes logic
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
        return episodes;
    }

    _normalizeQuery(query: string): string {
        // Original _normalizeQuery logic
        const extras = [
            'EXTRA PART',
            'OVA',
            'SPECIAL',
            'RECAP',
            'FINAL SEASON',
            'BONUS',
            'SIDE STORY',
            'PART\\s*\\d+',
            'EPISODE\\s*\\d+'
        ];

        const pattern = new RegExp(`\\b(${extras.join('|')})\\b`, 'gi');

        let normalizedQuery: string = query
            .replace(/\b(\d+)(st|nd|rd|th)\b/g, '$1')
            .replace(/(\d+)\s*Season/i, '$1')
            .replace(/Season\s*(\d+)/i, '$1')
            .replace(pattern, '')
            .replace(/-.*?-/g, '')
            .replace(/\bThe(?=\s+Movie\b)/gi, '')
            .replace(/~/g, ' ')
            .replace(/\s+/g, ' ')
            .replace('.', ' ')
            .trim();

        console.log('NORMA QUERY', normalizedQuery);
        const match = normalizedQuery.match(/[^a-zA-Z0-9 ]/);

        if (match) {
            const index = match.index!;
            console.log("MATCH", index);
            return normalizedQuery.slice(0, index).trim();
        }

        console.log('QUERY', query);


        return normalizedQuery;
    }
}
