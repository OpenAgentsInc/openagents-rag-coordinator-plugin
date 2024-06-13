"use strict";

const Job = require("../lib/Job.cjs");

async function run() {  
    try{
        const job = await Job.get();
        let topK = 1;    
        let maxTokens = 256;
        let quantize = false;
        let overlap = 32;
        let cacheDurationHint = undefined;
        let noCache = false;
        let warmUp = false;
        let useTools=false;
        let toolsResultTemplate ="{{TOOL_RESULT}}";
        let expectedResults = 1;
        let maxWaitTime = 1000 * 60 * 2;
        let toolWaitTime = 1000 * 10;
        let toolWhitelist = [];
        let trackToolUsage = true;
        let maxToolCalls = 3; 


        const documents = []; // plain text documents
        const documentsUrls = []; // urls to documents
        const queries = []; // plain text queries

        // Merge classic JobInputs and params with extism inputString
        for(const input of job.input){
            if(input.marker === "query"){
                queries.push(input.data);
            } else {
                if(input.type=="url"){
                    documentsUrls.push(input.data);
                }else{
                    documents.push(input.data);
                }
            }
        }  

        for(const param of job.param){
            if(param.key=="k"){
                const value=Number(param.value[0]);
                topK=value;
            }else if(param.key=="max-tokens"){
                const value = Number(param.value[0]);
                maxTokens=value;
            }else if(param.key=="quantize"){
                quantize = param.value[0] =="true";
            }else if(param.key=="overlap"){
                const value = Number(param.value[0]);
                overlap=value;
            }else if(param.key=="cache-duration-hint"){
                cacheDurationHint = param.value[0];
            }else if(param.key=="no-cache"){
                noCache = param.value[0] =="true";
            }else if(param.key=="warm-up"){
                warmUp = param.value[0] == "true";
                maxWaitTime = 1000*60*60;
            }else if(param.key=="use-tools"){
                useTools = param.value[0] =="true";
            }else if(param.key=="tools-result-template"){
                toolsResultTemplate = param.value[0];
            }else if(param.key=="tools-whitelist"){
                toolWhitelist.push(...param.value);
            }else if(param.key=="track-tool-usage"){
                trackToolUsage = param.value[0] =="true";
            }else if(param.key=="max-tool-calls"){
                maxToolCalls = Number(param.value[0]);
            }
        }

        const cacheParams = [];
        if(cacheDurationHint){
            cacheParams.push(await Job.newParam("cache-duration-hint", cacheDurationHint));
        }
        if(noCache||warmUp){
            cacheParams.push(await Job.newParam("no-cache", noCache));
        }

        let newContext = "";
        let meta={
            usedTools: []
        };

        if (documentsUrls.length>0||documents.length>0){
            Job.log("Starting rag pipeline with k="+topK+", max-tokens="+maxTokens+", quantize="+quantize+", overlap="+overlap+", cache-duration-hint="+cacheDurationHint+", no-cache="+noCache);
            Job.log("Fetching documents...");
            const downloadDocumentsReq =  Job.subrequest({
                runOn: "openagents/document-retrieval",
                outputFormat: "application/hyperdrive+bundle",
                inputs: await Promise.all(documentsUrls.map((d) => Job.newInputData(d, "url"))),
                params: cacheParams
            });

            Job.log("Creating embeddings for  queries...");
            const embedQueriesReq = Job.subrequest({
                runOn: "openagents/embeddings",
                outputFormat: quantize?"application/json":"application/hyperdrive+bundle",
                inputs: [
                    ...await Promise.all(queries.map((query) => Job.newInputData(query, "text", "query"))),
                ],
                params: [
                    await Job.newParam("max-tokens", maxTokens),
                    await Job.newParam("overlap", overlap),
                    await Job.newParam("quantize", quantize),
                    ...cacheParams
                ]
            });

            const documentsBundle = await Job.waitForContent(downloadDocumentsReq, expectedResults, maxWaitTime);
        
            Job.log("Creating embeddings for documents...");
            const documentsEmbeddingReq = Job.subrequest({
                runOn: "openagents/embeddings",
                outputFormat: "application/hyperdrive+bundle",
                inputs: [
                    await Job.newInputData(documentsBundle, "application/hyperdrive+bundle", "passage"),
                    ...await Promise.all(documents.map((doc) => Job.newInputData(doc, "text", "passage")))
                ],
                params: [
                    await Job.newParam("max-tokens", maxTokens),
                    await Job.newParam("overlap", overlap),
                    await Job.newParam("quantize", quantize),
                    ...cacheParams
                ]
            });

            const [queriesEmbeddingBundle, documentsEmbeddingBundle] = await Promise.all([
                Job.waitForContent(embedQueriesReq, expectedResults, maxWaitTime), 
                Job.waitForContent(documentsEmbeddingReq, expectedResults, maxWaitTime)
            ]);

            Job.log("Searching...");
            const searchReq = Job.subrequest({
                runOn: "openagents/search",
                outputFormat: "application/json",
                inputs: [
                    await Job.newInputData(documentsEmbeddingBundle, "application/hyperdrive+bundle", "index"),
                    await Job.newInputData(queriesEmbeddingBundle, quantize?"application/json":"application/hyperdrive+bundle", "query")
                ],
                params: [
                    await Job.newParam("k", topK),
                    await Job.newParam("normalize", "true"),
                    ...cacheParams
                ]
            });

            const searchResult = JSON.parse(await Job.waitForContent(searchReq, expectedResults, maxWaitTime));       
            Job.log("Merging context... "+searchResult.length+" results found");
            for(const result of searchResult){
                newContext+=result.value+"\n";
            }
        }

        // Send tool req
        if (!warmUp && useTools) {
            try{
                Job.log("Sending tool request...");
                const toolsInputs = [];
                for (const query of queries) {
                    toolsInputs.push(await Job.newInputData(query, "text", "query"));
                }
                if(newContext) toolsInputs.push(await Job.newInputData(newContext, "text", "context"));

                const toolsParams = [];
                if (toolWhitelist.length > 0) {
                    toolsParams.push(await Job.newParam("tools-whitelist", toolWhitelist));
                }
                
                toolsParams.push(await Job.newParam("max-tool-calls", maxToolCalls));
                toolsParams.push(await Job.newParam("track-tool-usage", trackToolUsage));
                
                const toolReq = Job.subrequest({
                    runOn: "openagents/tool-selector",
                    outputFormat: "application/json",
                    inputs: toolsInputs,
                    params: [
                        ...cacheParams,
                        ...toolsParams
                    ]
                });

                Job.log("Merging tools result...");
                let toolResult = await Job.waitForContent(toolReq, expectedResults, toolWaitTime);
                try{
                    const toolData = JSON.parse(toolResult);
                    for(const msg of toolData){
                        if(typeof msg == "object" && msg.sources){
                            for(const source of msg.sources){
                                // newContext += "Source: "+source.name+"\n";
                                meta.usedTools.push(source.id);                                                         
                            }
                        }
                    }
                }catch(e){
                    Job.log("Error when using tools "+e.message);
                }
                toolResult = toolsResultTemplate.replace("{{TOOL_RESULT}}", toolResult);
                newContext += toolResult + "\n";
            }catch(e){
                Job.log("Error when using tools "+e.message);
            }
        }       
        Job.log("Output ready. Returning...");
        Host.outputString(JSON.stringify({content: newContext, meta: meta}));
    }catch(e){
        await Job.log("Error! "+e.message);
        Host.outputString("");
    }

}

module.exports = { run };