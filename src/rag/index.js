"use strict";

const Job = require("../lib/Job.cjs");

async function run() {  

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

    // Early return if no documents 
    if (documents.length === 0 && documentsUrls.length === 0) {
        Host.outputString("");
        return;
    }
   

    for(const param of job.param){
        if(param.key=="k"){
            const value=Number(param.value);
            topK=value;
        }else if(param.key=="max-tokens"){
            const value=Number(param.value);
            maxTokens=value;
        }else if(param.key=="quantize"){
            quantize=param.value=="true";
        }else if(param.key=="overlap"){
            const value=Number(param.value);
            overlap=value;
        }else if(param.key=="cache-duration-hint"){
            cacheDurationHint=param.value;
        }else if(param.key=="no-cache"){
            noCache = param.value=="true";
        }else if(param.key=="warm-up"){
            warmUp = param.value == "true";
        }else if(param.key=="use-tools"){
            useTools=param.value=="true";
        }else if(param.key=="tools-result-template"){
            toolsResultTemplate=param.value;
        }
    }

    const cacheParams = [];
    if(cacheDurationHint){
        cacheParams.push(await Job.newParam("cache-duration-hint", cacheDurationHint));
    }
    if(noCache||warmUp){
        cacheParams.push(await Job.newParam("no-cache", noCache));
    }

    // Send tool req
    let toolReq;
    if (!warmUp && useTools){
        Job.log("Send tool request...");
        toolReq = Job.subrequest({
            runOn: "openagents/tools",
            outputFormat: "application/json",
            inputs: [
                await Job.newInputData(queries, "text", "queries")
            ],
            params: [
                ...cacheParams
            ]
        });    
    }

    Job.log("Starting rag pipeline with k="+topK+", max-tokens="+maxTokens+", quantize="+quantize+", overlap="+overlap+", cache-duration-hint="+cacheDurationHint+", no-cache="+noCache);
    Job.log("Fetch documents...");
    const downloadDocumentsReq =  Job.subrequest({
        runOn: "openagents/document-retrieval",
        outputFormat: "application/hyperdrive+bundle",
        inputs: await Promise.all(documentsUrls.map((query) => Job.newInputData(query, "url"))),
        params: cacheParams
    });

    Job.log("Create embeddings for  queries...");
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

    const documentsBundle = await Job.waitForContent(downloadDocumentsReq);
   
    Job.log("Create embeddings for documents...");
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

    const [queriesEmbeddingBundle, documentsEmbeddingBundle] = await Promise.all([Job.waitForContent(embedQueriesReq), Job.waitForContent(documentsEmbeddingReq)]);

    Job.log("Search...");
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

    try{
        const searchResult = JSON.parse(await Job.waitForContent(searchReq));        
        Job.log("Merge context... "+searchResult.length+" results found");
        let newContext ="";
        for(const result of searchResult){
            newContext+=result.value+"\n";
        }
        if(toolReq){
            Job.log("Merge tools result...");
            let toolResult = await Job.waitForContent(toolReq);
            toolResult = toolsResultTemplate.replace("{{TOOL_RESULT}}", toolResult);
            newContext+=toolResult+"\n";
        }
        Host.outputString(newContext);
    }catch(e){
        await Job.log("Error! "+e.message);
        Host.outputString("");
    }

}

module.exports = { run };