/// <reference path="./onlinestream-provider.d.ts" />
/// <reference path="./core.d.ts" />

class Provider {

    private apiBaseUrl: string = "{{baseUrl}}";
    private cookies: string = "";
    private csrfToken: string = "";
    private cookiesExpirationDate: Date | null = null;

    getSettings(): Settings {
        return {
            episodeServers: ["Server1", "Server2"],
            supportsDub: true,
        }
    }

    async search(query: SearchOptions): Promise<SearchResult[]> {

        let data: any[] = [];
        let allTitles:any[] = [];
        let allRecords: any[] = [];

        let isManualSearch = !query.media.startDate || !query.media.startDate.year;
        allTitles = (isManualSearch ? [query.query] : [query.media.romajiTitle, query.media.englishTitle, query['query'], ...query.media.synonyms]).filter(Boolean) as string[];

        const smartSearch = $scannerUtils.buildSmartSearchTitles(allTitles);
        smartSearch.titles.push(query.query);
        const animeId = query.media.id;

        console.log(`Smart search titles: ${smartSearch.titles.join(' | ')}`);
        console.log(`Season: ${smartSearch.season}, Part: ${smartSearch.part}`);

        const queriesToTry: string[] = [];
        for (let title of smartSearch.titles) {
            const cleaned = $scannerUtils.sanitizeQuery(title).toLowerCase().trim();
            if (cleaned && !queriesToTry.includes(cleaned)) {
                queriesToTry.push(cleaned);
            }
            const bsq = $scannerUtils.buildSearchQuery(title).toLowerCase().trim();
            if (bsq && !queriesToTry.includes(bsq)) {
                queriesToTry.push(bsq);
            }
        }

        console.log(`Queries to try: ${queriesToTry.join(', ')}`);

        for (let searchQuery of queriesToTry) {
            let offset = 0;
            const pageSize = 30;
            
            
            console.log(`Try: ${searchQuery}. Dubbed: ${query.dub ? 'Yes' : 'No'}`);

            for (let page = 0; page < 10; page++) {
                let postBody = {
                    title: searchQuery,
                    type: false,
                    year: false,
                    order: false,
                    status: false,
                    genres: false,
                    offset: offset,
                    dubbed: query.dub,
                    season: false
                };

                let response = await this._postSearch(postBody);
                if (!response) break;

                let records: any[] = response.records || [];
                console.log(`POST offset ${offset}: ${records.length} record`);

                if (records.length === 0) break;

                allRecords.push(...records);
                
                if(!isManualSearch) {
                    // Step 1: Exact match for anilist_id
                    data = allRecords.filter((x: any) => x?.anilist_id == animeId);
                    if (data.length !== 0) {
                        console.log(`Match found for anilist_id: ${animeId}`);
                        break;
                    }
                }

                // If less than pageSize, there are no more pages
                if (records.length < pageSize) break;

                offset += records.length;
                $sleep(200);
            }

            if (data.length !== 0 && !isManualSearch) break;

            $sleep(200);
        }

        console.log(`Anime found: ${isManualSearch ? allRecords.length : data.length} results`);

        let filteredRecords = (isManualSearch ? allRecords : data).filter(x => {
            // x.dub can be unreliable when the API doesn't filter (dubbed: false means "no filter")
            // Use title "(ITA)" suffix as an additional dub indicator
            const isDub = x.dub == 1 || (x.title && x.title.includes('(ITA)'));
            return query.dub ? isDub : !isDub;
        });
        console.log(`Filtered by ${query.dub ? 'dub' : 'sub'}: ${filteredRecords.length} results`);

        let finalResults: SearchResult[] = filteredRecords.map((item: any): SearchResult => (
            {
                id: `${item.id.toString()}-${item.slug}`,
                title: item.title ?? item.title_eng ?? item.title_it,
                url: `${this.apiBaseUrl}/anime/${item.id.toString()}-${item.slug}`,
                subOrDub: item.dub == 1 ? 'dub' : 'sub'
            }
        ));

        return finalResults;
    }

    /**
     * POST to /archivio/get-animes with CSRF token and session cookie.
     * header X-Requested-With: XMLHttpRequest is mandatory.
     */
    async _postSearch(body: any): Promise<any> {
        try {
            await this._updateCookies();

            let response = await fetch(`${this.apiBaseUrl}/archivio/get-animes`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json, text/plain, */*",
                    "X-Requested-With": "XMLHttpRequest",
                    "X-CSRF-TOKEN": this.csrfToken,
                    "Cookie": this.cookies,
                    "Referer": `${this.apiBaseUrl}/archivio`,
                    "Origin": this.apiBaseUrl,
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
                },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                console.error(`POST /archivio/get-animes failed: ${response.status} ${response.statusText}`);
                return null;
            }
            

            return response.json();
        } catch (e: any) {
            console.error(`POST search error: ${e.message || e}`);
            return null;
        }
    }
    async findEpisodes(id: string): Promise<EpisodeDetails[]> {

        const animeId = id.split('-')[0];
        let response = await this._makeRequest(`/info_api/${animeId}/0`, "GET", null, null, "json");
        let episodesAmount = response["episodes_count"];
        const episodes = await this._getAnimeEpisodes(0, episodesAmount, animeId);

        return episodes;
    }
    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        let server = "server1"
        if (_server !== "default") server = _server

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
                console.log("Master playlist:", masterPlaylist);
            }
        }

        if (embedHtml.includes('window.streams')) {
            let match = embedHtml.match(/window\.streams\s*=\s*(\[[\s\S]*?\]);/s);
            if (match) {
                let jsCode = `window = {}; window.streams = ${match[1]}; return window.streams;`;
                playlistStreams = new Function(jsCode)();
                console.log("Playlist streams:", playlistStreams);
            }
        }

        // 2025-10-15 12:48:17 |DBG| log > {"params":{"asn":"","expires":"1765716497","token":"8bad3efd1da2779741b47a3f0080d256"},"url":"https://vixcloud.co/playlist/304645?b=1"}
        // 2025-10-15 12:48:17 |DBG| log > [{"active":false,"name":"Server1","url":"https://vixcloud.co/playlist/304645?b=1\u0026ub=1"},{"active":1,"name":"Server2","url":"https://vixcloud.co/playlist/304645?b=1\u0026ab=1"}]

        //GET Playlist urls
        console.log(`_server: "${_server}", server: "${server}"`);
        console.log(`Available streams: ${playlistStreams.map((s: any) => s.name).join(', ')}`);

        let selectedStream = playlistStreams.find((playlist: any) =>
            playlist.name.replace(/\s+/g, '').toLowerCase() === server.replace(/\s+/g, '').toLowerCase()
        );

        // Fallback: if not found, take the first available stream
        if (!selectedStream) {
            console.log(`Server "${server}" not found, using the first available stream`);
            selectedStream = playlistStreams[0];
        }

        console.log("Selected stream:", selectedStream);
        let playlistUrl = selectedStream.url.replace(/\\u0026/g, "&").replace("\u0026", "&");
        playlistUrl = `${playlistUrl}&token=${masterPlaylist.params.token}&expires=${masterPlaylist.params.expires}&h=1`;

        response = await fetch(playlistUrl);
        let playlistContent = response.text();

        // #EXTM3U

        // #EXT-X-STREAM-INF:BANDWIDTH=1200000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=854x480

        // https://vixcloud.co/playlist/304645?type=video&rendition=480p&token=0UAeINVLHokfgxA2XOmEbw&expires=1765717171&edge=au-u3-01

        // #EXT-X-STREAM-INF:BANDWIDTH=2150000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1280x720

        // https://vixcloud.co/playlist/304645?type=video&rendition=720p&token=eqC_pgU64QDVHP90n9g6IA&expires=1765717171&edge=au-u3-01

        // #EXT-X-STREAM-INF:BANDWIDTH=4500000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080

        // https://vixcloud.co/playlist/304645?type=video&rendition=1080p&token=FiJectPI0_goEM35lIwtuA&expires=1765717171&edge=au-u3-01

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

    async _updateCookies(): Promise<void> {

        let now: Date = new Date();

        if (this.cookiesExpirationDate == null || this.cookiesExpirationDate < now) {
            try {
                let response = await fetch(this.apiBaseUrl, { method: "GET" });

                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

                // Salva TUTTI i cookie dalla risposta (XSRF-TOKEN + session)
                let cookiePairs: string[] = [];
                let responseCookies = response.cookies;
                for (let name in responseCookies) {
                    cookiePairs.push(`${name}=${responseCookies[name]}`);
                }
                this.cookies = cookiePairs.join("; ");

                // Estrai CSRF token dall'HTML della pagina (meta tag)
                let html = response.text();
                let $ = LoadDoc(html);
                let csrfMeta = $('meta[name="csrf-token"]').attr('content');
                if (csrfMeta) {
                    this.csrfToken = csrfMeta;
                    console.log("CSRF token extracted from meta tag");
                }

                // Scadenza: 1 ora da adesso
                this.cookiesExpirationDate = new Date(now.getTime() + 3600000);
            }
            catch (error: any) {
                console.error(error);
            }
        }
    }

    async _makeRequest(endpoint: string, method: string = "GET", body: any = null, headers: any = null, returnType: "json" | "text" = "text"): Promise<string | any> {

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
            let response = await fetch(`${this.apiBaseUrl}/${endpoint}`, options)
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)

            if (returnType === "text") return await response.text();

            return await response.json()
        }
        catch (error: any) {
            console.error(error);
        }
    }

    async _getAnimeEpisodes(start: number, end: number, animeId: string | number, episodeLimitForIteration: number = 120): Promise<EpisodeDetails[]> {

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
}