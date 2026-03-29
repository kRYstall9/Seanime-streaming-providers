/// <reference path="./onlinestream-provider.d.ts" />
/// <reference path="./core.d.ts" />

class Provider {

    baseUrl: string = 'https://animetsu.net';
    api: string = `${this.baseUrl.endsWith("/") ? this.baseUrl.slice(0, -1) : this.baseUrl}/v2/api/anime`;
    threshold: number = 0.7;
    headers = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Referer': `${this.baseUrl}`,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 OPR/128.0.0.0'
};

    getSettings(): Settings {
        return {
            episodeServers: ["pahe", "zoro", "zaza", "bato", "megg"],
            supportsDub: true,
        }
    }

    async search(query: SearchOptions): Promise<SearchResult[]> {
        const normalizedQuery = normalizeQuery(query.query);
        console.debug(normalizedQuery);

        const language: string = query.dub ? "dub" : "sub";
        let url = `${this.api}/search?query=${encodeURIComponent(normalizedQuery)}&page=1&year=${query.year != null ? query.year : 'any'}`;

        console.debug(url);
        try {
            let response = await _makeRequest(url, this.headers);
            let data = JSON.parse(response);

            console.debug("Data from API: ", data);
            if (data?.total == 0) {
                console.debug("No results found with the original query, trying with the title from AniList...");
                url = `${this.api}/search?query=${encodeURIComponent(query.query)}&page=1&year=${query.year != null ? query.year : 'any'}`;
                response = await _makeRequest(url, this.headers);
                data = JSON.parse(response);
            }

            const pages = data["last_page"];

            console.debug("Total pages: ", pages);

            const aniListTitlesAndSynonyms = [query.media.englishTitle ?? "", query.media.romajiTitle ?? "", ...query.media.synonyms];
            const validTitles = new Map<string, LevenshteinResult>();
            const results: SearchResult[] = [];
            let shouldContinue: boolean = true;

            for (let i = 1; i <= pages; i++) {
                if (i > 1) {
                    url = `${url.split("&page")[0]}&page=${i}`;
                    try {
                        response = await _makeRequest(url, this.headers);
                    }
                    catch (error: any) {
                        console.error(error);
                    }
                }

                for (let anime of data.results) {
                    let japaneseTitle = anime.title.romaji;
                    let title = anime.title.english;
                    let nativeTitle = anime.title.native;
                    let id = anime.id;
                    let url = `${this.baseUrl}/anime/${id}`;
                    let subOrDub: SubOrDub = query.dub ? "dub" : "sub";
                    const titles = [japaneseTitle, title, nativeTitle];

                    try {
                        for (let t of titles) {

                            let bestScore: number | null = filterBySimilarity(t, aniListTitlesAndSynonyms, this.threshold);
                            if (bestScore != null) {
                                validTitles.set(title, { score: bestScore, subOrDub: subOrDub, title: title });
                                if (bestScore == 1) {
                                    shouldContinue = false;
                                    break;
                                }
                            }
                        }
                    }
                    catch (error) {
                        console.error("Error: " + error);
                    }

                    results.push({
                        id: `${id}/${subOrDub}`,
                        title: title,
                        url: url,
                        subOrDub: subOrDub,
                    });

                    if (!shouldContinue)
                        break;
                }
                if (!shouldContinue)
                    break;
            }

            console.debug(validTitles);
            if (validTitles.size > 0) {
                let bestMatch = Array.from(validTitles.values()).reduce((prev, current) => (prev.score > current.score) ? prev : current);

                console.log("Best Match ", bestMatch);
                let animeToReturn = results.filter((anime: any) => anime.subOrDub == (query['dub'] ? "dub" : "sub")).filter((anime: any) => anime.title.toLowerCase() === bestMatch.title.toLowerCase())[0];

                if (animeToReturn) {
                    return [animeToReturn];
                }
            }

            //Need this to force no results
            throw new Error("No results found");

        }
        catch (error: any) {
            console.error(error);
            throw new Error(error);
        }
    }
    async findEpisodes(id: string): Promise<EpisodeDetails[]> {

        const url = `${this.api}/eps/${id.split('/dub')[0].split('/sub')[0]}`;

        console.log(url);

        try {

            const response = await _makeRequest(url, this.headers);
            const data: any[] = JSON.parse(response);
            const episodes: EpisodeDetails[] = [];

            console.log(data,  data.length);

            const animeId = id.split('/dub')[0].split('/sub')[0];
            console.debug("Anime ID: ", animeId);
            for (let episode of data) {

                episodes.push({
                    id: `animeid=${animeId}&ep_id=${episode["id"]}/${id.includes('/dub') ? 'dub' : 'sub'}`,
                    number: episode["ep_num"] ?? data.indexOf(episode) + 1,
                    url: ``,
                    title: episode["name"]
                })
            }

            return episodes;

        }
        catch (error: any) {
            console.error(error);
            throw new Error(error);
        }
    }
    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        let server = "zaza"
        if (_server !== "default") server = _server

        //TODO
        //https://backend.animetsu.to/api/anime/servers?id=21&num=1 -> this.api/servers?${episode.id}
        //Returns something like this
        // [
        //     {
        //         "id": "pahe",
        //         "hasDub": true,
        //         "default": true
        //     },
        //     {
        //         "id": "zoro",
        //         "hasDub": true,
        //         "default": false
        //     },
        //     {
        //         "id": "bato",
        //         "hasDub": true,
        //         "default": false
        //     },
        //     {
        //         "id": "zaza",
        //         "hasDub": true,
        //         "default": false
        //     },
        //     {
        //         "id": "meg",
        //         "hasDub": true,
        //         "default": false
        //     }
        // ]
        console.log(episode.id);
        const animeId = episode.id.split('&')[0].split('animeid=')[1];
        const episodeId = episode.id.split('&')[1].split('ep_id=')[1];
        const episodeIdWithoutLang = episodeId.split('/dub')[0].split('/sub')[0];

        console.debug("Anime ID: ", animeId);
        console.debug("Episode ID: ", episodeId);
        console.debug("Episode ID without language: ", episodeIdWithoutLang);

        this.headers['Referer'] = `${this.baseUrl}/watch/${animeId}`;

        let url = `${this.api}/servers/${animeId}/${episode.number}`;

        console.debug("Episode Servers URL: ", url);

        const serverProviders:any = await _makeRequest(url, this.headers);

        console.debug("Server providers data: ", serverProviders);

        if (serverProviders == null || serverProviders.length === 0) {
            throw new Error(`No providers found for server ${_server}`);
        }

        url = `${this.api}/oppai/${animeId}/${episode.number}?server=${server}&source_type=${episode.id.includes('/dub') ? 'dub' : 'sub'}`;

        console.debug("Episode Video Sources URL: ", url);
        
        try {
            const response = await _makeRequest(url, this.headers);
            console.log(response);
            
            const data = JSON.parse(response);

            console.debug("Video sources data: ", data);
            
            if (data?.sources == null || data?.sources.length === 0) {
                throw new Error(`No sources found for episode ${episode.number} on server ${_server}`);
            }
            
            const videoSources: VideoSource[] = data.sources.map((source: any) => {
                const fullUrl = `https://ani.metsu.site/${source?.['need_proxy'] != null ? 'proxy' : ''}${source?.url}`;
                return {
                    url: fullUrl,
                    type: source?.url?.includes('m3u8') ? 'm3u8' : source?.url?.includes('mp4') ? 'mp4' : 'unknown',
                    quality: source?.quality,
                    subtitles: (source?.subtitles ?? []).map((subtitle: any, index: number) => {
                        return {
                            id: index.toString(),
                            url: subtitle?.url,
                            language: subtitle?.lang,
                            isDefault: source?.subtitles?.length === 1 // If there's only one subtitle, set it as default
                        }
                    })
                }
            });

            this.headers['Referer'] = `${this.baseUrl}`;
            return {
                headers: this.headers,
                server: server,
                videoSources: videoSources
            }
        }
        catch (error: any) {
            console.error(error);
            throw new Error(error);
        }
    }
}


/**
 * Returns the HTML body of an HTTP response
 * 
 * @param url -> The URL to fetch
 * @returns  A string with the response body, or a fallback message if any error occurs
 */

async function _makeRequest(url: string, headers: any): Promise<string> {
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: headers
        });
        
        console.debug(`[${response.status}] ${url}`);  // <-- aggiungi questo
        
        if (!response.ok) {
            const errorBody = await response.text();
            console.error(`Error body: ${errorBody}`);  // <-- e questo
            throw new Error(`Failed to fetch: ${response.statusText}`);
        }
        const body = await response.text();
        console.debug(`Response body: ${body}`);  // <-- e questo
        return body;
    }
    catch (error) {
        console.error(error);
        return "";
    }
}

/**
 * 
 * Returns the number of single-character edits required to change one word into another
 * 
 * @param a -> String to compare
 * @param b -> String to be compared with
 * @returns 
 */

function levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];

    // Inizializza la prima colonna e riga della matrice
    for (let i = 0; i <= a.length; i++) {
        matrix[i] = [i];
    }

    for (let j = 0; j <= b.length; j++) {
        matrix[0][j] = j;
    }

    // Calcola la distanza
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;

            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,    // Cancellazione
                matrix[i][j - 1] + 1,    // Inserimento
                matrix[i - 1][j - 1] + cost // Sostituzione
            );
        }
    }

    return matrix[a.length][b.length];
}

/**
 * 
 * Returns the score based on the levenshtein distance algorithm
 * 
 * @param a -> String to compare
 * @param b -> String to be compared with
 * @returns 
 */

function similarityScore(a: string, b: string): number {
    const distance = levenshteinDistance(a, b);
    const maxLen = Math.max(a.length, b.length);

    // console.log("DISTANCE: " + distance);
    // console.log("MAXLEN: "+ maxLen);
    // console.log(1 - distance/maxLen);

    if (maxLen === 0) return 1; // Evita divisione per zero
    return 1 - distance / maxLen;
}

/**
 * 
 * Returns the highest score based on the levenshtein distance algorithm
 * 
 * @param input -> String to compare
 * @param candidates -> String[] to compare the input with
 * @param threshold
 * @returns 
 */

function filterBySimilarity(input: string, candidates: string[], threshold: number): number | null {

    if (!input || input.trim() === "") {
        console.error("Invalid input string.");
        return null;
    }

    let validMatches = candidates
        .map(candidate => ({
            title: candidate,
            score: similarityScore(normalizeStringBeforeLevenshtein(input), normalizeStringBeforeLevenshtein(candidate)),
        }))
        .filter(item => item.score >= threshold);

    if (validMatches.length > 0) {
        return validMatches.reduce((prev, current) => (prev.score > current.score) ? prev : current).score;
    }

    return null;

}

function normalizeQuery(query: string): string {

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
        .trim();

    const match = normalizedQuery.match(/[^a-zA-Z0-9 ]/);

    if (match) {
        const index = match.index!;
        return normalizedQuery.slice(0, index).trim();
    }

    return normalizedQuery;
}

/**
 * Replaces Season with empty string. 
 * Keeps the number and not the suffix -> [2nd] = [2]
 * Replaces any number of sequential whitespace with just one
 * Converts the string to lower case
 *  
 * @param input 
 * @returns 
 */

function normalizeStringBeforeLevenshtein(input: string): string {
    const normalized = input.replace(/Season/gi, '').replace(/\b(\d+)(st|nd|rd|th)\b/g, '$1').replace(/\s*\([^)]*\)\s*/gi, '').replace(/\s+/g, ' ').trim().toLowerCase();
    return normalized;
}

type LevenshteinResult = {
    title: string,
    score: number,
    subOrDub: SubOrDub
}

type EpisodeProvider = {
    provider: string,
    episodeNumber: number | undefined,
    episodeId: string | undefined,
    hasDub: boolean | undefined,
    dubRequested: boolean
}

type EpisodeObject = {
    animeId: string,
    providers:EpisodeProvider[]
}
