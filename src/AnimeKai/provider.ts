/// <reference path="./online-streaming-provider.d.ts" />
/// <reference path="./core.d.ts"/>

interface GenericResponse {
    status: number | string;
    result: string;
}

interface DecryptResponse {
    status: number;
    result: {
        url: string;
        skip: {
            intro: [number, number];
            outro: [number, number];
        }
    };
}

interface StreamUrl {
    type: string;
    url: string;
}

interface MegaResponse {
    status: number;
    result: {
        sources: { file: string }[];
        tracks: {
            file: string;
            label: string;
            kind: string;
            default?: boolean;
        }[];
        download: string;
    },
}

class Provider {
    private api: string = "{{baseUrl}}";
    private batchSize: number = Number("{{batchSize}}") ?? 50;
    private batchDelay: number = Number("{{batchDelay}}") ?? 500;

    getSettings(): Settings {
        return {
            episodeServers: ["Server 1", "Server 2"],
            supportsDub: true,
        };
    }

    async search(query: SearchOptions): Promise<SearchResult[]> {
        let normalizedQuery = this.normalizeQuery(query["query"]);
        console.log("Normalized Query: " + normalizedQuery);

        const url = `${this.api}/browser?keyword=${encodeURIComponent(
            normalizedQuery
        )}`;

        try {
            const data = await this.GETText(url);
            const $ = LoadDoc(data);
            const animes: SearchResult[] = [];
            $("div.aitem-wrapper>div.aitem").each((_, elem) => {
                const id = elem.find("a.poster").attr("href")?.slice(1) ?? "";
                const title = elem.find("a.title").attr("title") ?? "";
                const subOrDub: SubOrDub = this.isSubOrDubOrBoth(elem);
                const url = `${this.api}/${id}`;
                console.log(`Found: ${title} - ${url} - ${subOrDub}`);

                const anime: SearchResult = {
                    id: `${id}?dub=${query['dub']}`,
                    url: url,
                    title: title,
                    subOrDub: subOrDub,
                };

                animes.push(anime);
            });

            return animes;
        }
        catch (e: any) {
            throw new Error(e);
        }
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        let url = `${this.api}/${id.split('?dub')[0]}`;
        const rateBoxIdRegex = /<div class="rate-box"[^>]*data-id="([^"]+)"/;

        console.log(url);
        try {
            const pageHtml: string = await this.GETText(url);
            const idMatch = pageHtml.match(rateBoxIdRegex);
            const aniId = idMatch ? idMatch[1] : null;

            if (aniId === null) throw new Error("Anime ID not found");

            console.debug("Anime ID extracted:", aniId);
            
            url = `https://enc-dec.app/api/enc-kai?text=${encodeURIComponent(aniId)}`;

            console.debug("Requesting token with URL:", url);

            const token = await this.GETJson<GenericResponse>(url).then(res => res.result);

            url = `${this.api}/ajax/episodes/list?ani_id=${aniId}&_=${token}`;
            console.debug("Requesting episodes with URL:", url);

            const ajaxResult: GenericResponse = await this.GETJson(url);
            const $ = LoadDoc(ajaxResult.result);

            const episodeData = $('ul.range>li>a').map((_, elem) => ({
                name: `Episode ${elem.attr('num')}`,
                number: parseInt(elem.attr('num')!, 10),
                data: elem.attr('token')!,
                title: elem.find('span').text().replace(/\s/g, ' ')
            }));

            console.debug("Extracted episode data:", episodeData);

            const episodes: EpisodeDetails[] = (await processInBatches(episodeData, this.batchSize, this.batchDelay, async(item) => {
                let url = `https://enc-dec.app/api/enc-kai?text=${encodeURIComponent(item.data)}`;
                    console.debug("Requesting episode token with URL:", url);
                    const response = await fetch(url);
                    const result: GenericResponse = await response.json();

                    console.log("Received token response:", result);

                    if(result == null){
                        console.debug("Null token for ", url);
                    }

                    return {
                        id: item.data ?? "",
                        number: item.number,
                        title: item.title,
                        url: `${this.api}/ajax/links/list?token=${item.data}&_=${result?.result}?dub=${id.split('?dub=')[1]}`
                    };
                }
            ))
            .filter(result => {
                if(result.status === "rejected"){
                    console.error("Error processing episode:", result.reason);
                    return false;
                }
                return true;
            })
            .map(result => (result as PromiseFulfilledResult<EpisodeDetails>).value);
            
            console.debug("Constructed episode details:", episodes);
            console.debug(episodes.filter(ep => ep.url == null || ep.url === "" || ep.url.includes("undefined")), "Episodes with invalid URLs", episodes.filter(ep => ep.url == null || ep.url === "" || ep.url.includes("undefined")).length);

            return episodes;
        }
        catch (e: any) {
            throw new Error(e);
        }
    }

    async findEpisodeServer(
        episode: EpisodeDetails,
        _server: string
    ): Promise<EpisodeServer> {
        let server = "Server 1";
        if (_server !== "default") server = _server;

        console.debug(`Finding server for episode: ${JSON.stringify(episode)} with token ${episode.id} on ${server}`);

        const episodeUrl = episode.url.replace('\u0026', '&').split('?dub')[0];
        const dubRequested = episode.url.split('?dub=')[1];

        console.log("Episode URL: " + episodeUrl);

        try {
            const responseText = await this.GETJson<GenericResponse>(episodeUrl);

            console.debug("Received episode page response:", responseText);
            if((responseText.status != 'ok'  && responseText.status !== 200)|| !responseText.result){
                throw new Error(`Failed to fetch episode page: ${responseText.status}`);
            }

            console.debug("Received episode page HTML:", responseText);

            const cleanedHtml = cleanJsonHtml(responseText.result);
            const subRegex = /<div class="server-items lang-group" data-id="sub"[^>]*>([\s\S]*?)<\/div>/;
            const softsubRegex = /<div class="server-items lang-group" data-id="softsub"[^>]*>([\s\S]*?)<\/div>/;
            const dubRegex = /<div class="server-items lang-group" data-id="dub"[^>]*>([\s\S]*?)<\/div>/;

            const subMatch = subRegex.exec(cleanedHtml);
            const softsubMatch = softsubRegex.exec(cleanedHtml);
            const dubMatch = dubRegex.exec(cleanedHtml);

            const sub = subMatch ? subMatch[1].trim() : "";
            const softsub = softsubMatch ? softsubMatch[1].trim() : "";
            const dub = dubMatch ? dubMatch[1].trim() : "";

            const serverSpanRegex: RegExp =
                server == "Server 1" ?
                    /<span class="server"[^>]*data-lid="([^"]+)"[^>]*>Server 1<\/span>/ :
                    /<span class="server"[^>]*data-lid="([^"]+)"[^>]*>Server 2<\/span>/

            console.log(dub, sub);

            const serverMatch = dubRequested === 'true' ? serverSpanRegex.exec(dub) : serverSpanRegex.exec(sub);

            console.log("SERVER MATCH", serverMatch);

            const serverIdDub = serverSpanRegex.exec(dub)?.[1];
            const serverIdSoftsub = serverSpanRegex.exec(softsub)?.[1];
            const serverIdSub = serverSpanRegex.exec(sub)?.[1];

            //serverId = serverMatch[1];
            const tokenRequestData = [
                { name: "Dub", data: serverIdDub },
                { name: "Softsub", data: serverIdSoftsub },
                { name: "Sub", data: serverIdSub }
            ].filter(item => item.data !== undefined) as { name: string; data: string }[];

            const tokenResults = await Promise.all(
                tokenRequestData.map(async (item) => {
                    const response = await fetch(`https://enc-dec.app/api/enc-kai?text=${encodeURIComponent(item.data)}`);
                    return { name: item.name, data: await response.json() as GenericResponse };
                })
            );

            const serverIdMap = Object.fromEntries(tokenRequestData.map(item => [item.name, item.data]));

            const streamUrls: StreamUrl[] = tokenResults.map((result) => {
                return {
                    type: result.name,
                    url: `https://animekai.to/ajax/links/view?id=${serverIdMap[result.name]}&_=${result.data.result}`
                };
            });

            const decryptedUrls = await processStreams(streamUrls);

            const headers = {
                "Referer": "https://animekai.to/",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
            };

            const streamUrl = dubRequested === 'true' ? decryptedUrls.Dub : (decryptedUrls.Sub ?? decryptedUrls.Softsub);

            if (streamUrl == "") {
                throw new Error("Unable to find a valid source")
            }

            const streams = await fetch(streamUrl.replace("/e/", "/media/"), {
                headers: headers
            });

            const responseJson = await streams.json();
            const result = responseJson?.result;
            const postData = {
                "text": result,
                "agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
            }

            const finalJson: MegaResponse = await fetch("https://enc-dec.app/api/dec-mega", {
                method: "POST",
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(postData)
            }).then(res => res.json());

            if (!finalJson || finalJson.status !== 200) throw new Error("Failed to decrypt the final stream URL");
            if (!finalJson.result.sources || finalJson.result.sources.length === 0) throw new Error("No video sources found in the final response");

            const m3u8Link = finalJson.result.sources[0].file;
            const playlistResponse = await fetch(m3u8Link);

            //Regex to extract all the resolutions and url related to the resolutions available
            const regex = /#EXT-X-STREAM-INF:BANDWIDTH=\d+,RESOLUTION=(\d+x\d+)\s*(.*)/g;
            const videoSources: VideoSource[] = [];

            let resolutionMatch;

            while ((resolutionMatch = regex.exec(await playlistResponse.text())) !== null) {

                let url = "";

                if (resolutionMatch[2].includes("list")) {
                    url = `${m3u8Link.split(',')[0]}/${resolutionMatch[2]}`;
                }
                else {
                    url = `${m3u8Link.split('/list')[0]}/${resolutionMatch[2]}`
                }

                videoSources.push({
                    quality: resolutionMatch[1].split('x')[1] + 'p', // 1920x1080 -> 1080p
                    subtitles: [], //Subs are already integrated in the video source
                    type: 'm3u8', //Standard type for AnimeKai
                    url: url
                });
            }

            const episodeServer: EpisodeServer = {
                server: server,
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0'
                },
                videoSources: [...videoSources]
            };

            return episodeServer

        }
        catch (e: any) {
            throw new Error(e);
        }
    }

    normalizeQuery(query: string): string {
        let normalizedQuery = query
            .replace(/\b(\d+)(st|nd|rd|th)\b/g, "$1") //Removes suffixes from a number I.e. 3rd, 1st, 11th, 12th, 2nd -> 3, 1, 11, 12, 2
            .replace(/\s+/g, " ") //Replaces 1+ whitespaces with 1 whitespace
            .replace(/(\d+)\s*Season/i, "$1") //Removes season and keeps the number before the Season word
            .replace(/Season\s*(\d+)/i, "$1") //Removes season and keeps the number after the Season word
            .trim();

        return normalizedQuery;
    }

    async _makeRequest(url: string): Promise<FetchResponse> {
        const response = await fetch(url, {
            method: "GET",
            headers: {
                "DNT": "1",
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0",
                Cookie: "__ddg1_=;__ddg2_=;",
            },
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch: ${response.statusText}`);
        }
        return response;
    }

    async GETText(url: string): Promise<string> {
        return await this._makeRequest(url).then(res => res.text());
    }

    async GETJson<T>(url: string): Promise<T> {
        return await this._makeRequest(url).then(res => res.json());
    }

    isSubOrDubOrBoth(elem: DocSelection): SubOrDub {
        const sub = elem.find("span.sub").text();
        const dub = elem.find("span.dub").text();

        if (sub != "" && dub != "") {
            return "both";
        }
        if (sub != "") {
            return "sub";
        }

        return "dub";
    }
}

function cleanJsonHtml(jsonHtml: string) {
    if (!jsonHtml) {
        return "";
    }
    return jsonHtml
        .replace(/\\"/g, "\"")
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, "\\")
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\r/g, "\r")
        .replace(/\\u([\dA-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

async function processStreams(streamUrls: StreamUrl[]): Promise<{ [key: string]: string }> {
    const streamResponses = await Promise.all(
        streamUrls.map(async ({ type, url }) => {
            try {
                const json: GenericResponse = await fetch(url).then(r => r.json());
                return { type, result: json.result };
            } catch (error) {
                console.log(`Error fetching ${type} stream:`, error);
                return { type, result: null };
            }
        })
    );

    const decryptResults = await Promise.all(
        streamResponses
            .filter(item => item.result !== null)
            .map(async item => {
                const result: DecryptResponse = await fetch("https://enc-dec.app/api/dec-kai", {
                    headers: { 'Content-Type': 'application/json' },
                    method: "POST",
                    body: JSON.stringify({ text: item.result })
                }).then(res => res.json());

                return { [item.type]: result.result.url };
            })
    );

    return Object.assign({}, ...decryptResults);
};

async function processInBatches<T>(items: any[], batchSize: number, delayMs: number, fn: (item:any) => Promise<T>): Promise<PromiseSettledResult<T>[]> {
    const results: PromiseSettledResult<T>[] = [];
    
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const batchResults = await Promise.allSettled(batch.map(fn));
        results.push(...batchResults);
        
        if (i + batchSize < items.length) {
            console.debug(`Batch done, waiting ${delayMs}ms...`);
            $sleep(delayMs);
        }
    }
    
    return results;
}