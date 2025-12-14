/// <reference path="./onlinestream-provider.d.ts" />
/// <reference path="./core.d.ts" />

class Provider {

    private apiBaseUrl: string = "{{domain}}";
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

        // 2025-10-15 12:48:17 |DBG| log > {"params":{"asn":"","expires":"1765716497","token":"8bad3efd1da2779741b47a3f0080d256"},"url":"https://vixcloud.co/playlist/304645?b=1"}
        // 2025-10-15 12:48:17 |DBG| log > [{"active":false,"name":"Server1","url":"https://vixcloud.co/playlist/304645?b=1\u0026ub=1"},{"active":1,"name":"Server2","url":"https://vixcloud.co/playlist/304645?b=1\u0026ab=1"}]

        //GET Playlist urls
        let playlistUrl = playlistStreams.filter((stream: any) => stream.name == server)[0]["url"].replace("\u0026", "&");
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
                let response = await fetch(this.apiBaseUrl, { method: "GET", credentials: "include" });

                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

                let cookies: string = JSON.parse(JSON.stringify(response.headers))["Set-Cookie"];
                let cookiesParts: string[] = cookies.split(";");
                let expirationDateString: string = cookiesParts.find((p: string) => p.toLowerCase().startsWith("expires="))?.split("Expires=")[1].split(";")[0].trim() || "";
                this.cookiesExpirationDate = new Date(expirationDateString);
                this.cookies = cookiesParts.find((p: string) => p.toLowerCase().startsWith("xsrf-token=") ? p.trim() : "") || "";
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

    _normalizeQuery(query: string): string {

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
            .replace(/\b(\d+)(st|nd|rd|th)\b/g, '$1') //Removes suffixes from a number I.e. 3rd, 1st, 11th, 12th, 2nd -> 3, 1, 11, 12, 2
            .replace(/(\d+)\s*Season/i, '$1') //Removes season and keeps the number before the Season word
            .replace(/Season\s*(\d+)/i, '$1') //Removes season and keeps the number after the Season word
            .replace(pattern, '') //Removes extras
            .replace(/-.*?-/g, '') // Removes -...-
            .replace(/\bThe(?=\s+Movie\b)/gi, '')
            .replace(/~/g, ' ') //Removes ~
            .replace(/\s+/g, ' ') //Replaces 1+ whitespaces with 1
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