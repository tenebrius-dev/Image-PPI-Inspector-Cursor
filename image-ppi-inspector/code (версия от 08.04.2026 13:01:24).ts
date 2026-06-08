figma.showUI(__html__, { width: 300, height: 100 });

function findAllImageNodes(nodes: readonly SceneNode[]): SceneNode[] {
    let imageNodes: SceneNode[] = [];
    for (const node of nodes) {
        if (!node.visible) continue;
        if ('fills' in node && Array.isArray(node.fills)) {
            if (node.fills.some(fill => fill.type === 'IMAGE' && fill.imageHash)) {
                imageNodes.push(node);
            }
        }
        if ('findAll' in node) {
            const children = node.findAll(child => child.visible &&
                'fills' in child &&
                Array.isArray(child.fills) &&
                child.fills.some(fill => fill.type === 'IMAGE' && fill.imageHash));
            imageNodes = imageNodes.concat(children as SceneNode[]);
        }
    }
    return imageNodes;
}

async function checkSelection() {
    const selection = figma.currentPage.selection;
    const imageNodes = findAllImageNodes(selection);
    
    if (imageNodes.length === 0) {
        figma.ui.postMessage({ type: "clear" });
        return;
    }
    
    const imagesData = await Promise.all(imageNodes.map(async (node) => {
        const fill = (node as any).fills.find((f: any) => f.type === 'IMAGE');
        const image = figma.getImageByHash(fill.imageHash);
        let size;
        try {
            size = await image!.getSizeAsync();
        } catch (e) {
            await image!.getBytesAsync();
            size = await image!.getSizeAsync();
        }
        const transform = fill.imageTransform;
        const scaleX = transform ? transform[0][0] : 1;
        const scaleY = transform ? transform[1][1] : 1;
        const ppiX = size.width / (node.width / scaleX / 72);
        const ppiY = size.height / (node.height / scaleY / 72);
        const stablePPI = (ppiX + ppiY) / 2;
        
        return {
            id: node.id,
            name: node.name,
            ppi: stablePPI,
            resScaleX: (72 / ppiX) * 100,
            resScaleY: (72 / ppiY) * 100,
            curW: node.width,
            curH: node.height,
            origW: size.width,
            origH: size.height,
            printW: (node.width / 72) * 25.4,
            printH: (node.height / 72) * 25.4,
            maxW: (size.width / 300) * 25.4,
            maxH: (size.height / 300) * 25.4,
            aspectRatio: node.height / node.width
        };
    }));
    
    figma.ui.postMessage({ type: "images-list", images: imagesData });
}

figma.on("selectionchange", checkSelection);

// ИСПРАВЛЕНИЕ: Оборачиваем documentchange в loadAllPagesAsync для обхода incremental mode
figma.loadAllPagesAsync().then(() => {
    figma.on("documentchange", (event) => {
        for (const change of event.documentChanges) {
            if (change.type === 'PROPERTY_CHANGE') {
                const isSelected = figma.currentPage.selection.some(node => node.id === change.id);
                if (isSelected) {
                    checkSelection();
                    break;
                }
            }
        }
    });
});

checkSelection();

figma.ui.onmessage = async (msg) => {
    if (msg.type === 'resize-window') {
        figma.ui.resize(msg.width, Math.round(msg.height));
    }
    
    if (msg.type === 'notify' && msg.msg) {
        figma.notify(msg.msg);
    }
    
    if (msg.type === 'focus-node' && msg.nodeId) {
        const node = figma.getNodeById(msg.nodeId) as SceneNode;
        if (node) {
            figma.currentPage.selection = [node];
            figma.viewport.scrollAndZoomIntoView([node]);
        }
    }
    
    if (msg.type === 'scan-page') {
        const allImageNodes = findAllImageNodes(figma.currentPage.children);
        if (allImageNodes.length === 0) {
            figma.ui.postMessage({ type: "scan-results", images: [], total: 0 });
            return;
        }
        const results = [];
        for (const node of allImageNodes) {
            try {
                const fill = (node as any).fills.find((f: any) => f.type === 'IMAGE');
                const image = figma.getImageByHash(fill.imageHash);
                let size;
                try {
                    size = await image!.getSizeAsync();
                } catch (e) {
                    await image!.getBytesAsync();
                    size = await image!.getSizeAsync();
                }
                const transform = fill.imageTransform;
                const scaleX = transform ? transform[0][0] : 1;
                const scaleY = transform ? transform[1][1] : 1;
                const ppiX = size.width / (node.width / scaleX / 72);
                const ppiY = size.height / (node.height / scaleY / 72);
                const stablePPI = (ppiX + ppiY) / 2;
                
                if (stablePPI < 250) {
                    results.push({
                        id: node.id,
                        name: node.name,
                        ppi: stablePPI,
                        resScaleX: (72 / ppiX) * 100,
                        resScaleY: (72 / ppiY) * 100,
                        curW: node.width,
                        curH: node.height,
                        origW: size.width,
                        origH: size.height,
                        printW: (node.width / 72) * 25.4,
                        printH: (node.height / 72) * 25.4,
                        maxW: (size.width / 300) * 25.4,
                        maxH: (size.height / 300) * 25.4,
                        aspectRatio: node.height / node.width
                    });
                }
            } catch (err) {
                console.error("Error processing node", node.id, err);
            }
        }
        results.sort((a, b) => a.ppi - b.ppi);
        figma.ui.postMessage({ type: "scan-results", images: results, total: allImageNodes.length });
    }
    
    if (msg.type === 'resize' && msg.nodeId) {
        const node = figma.getNodeById(msg.nodeId) as any;
        if (node) {
            const newWidth = (msg.origW / msg.targetPpi) * 72;
            node.resize(newWidth, newWidth * msg.aspectRatio);
            checkSelection();
            figma.notify(`✅ Resized to ${msg.targetPpi} PPI`);
        }
    }
    
    if (msg.type === 'download-image' && msg.nodeId) {
        const node = figma.getNodeById(msg.nodeId) as any;
        const fill = node.fills.find((f: any) => f.type === 'IMAGE');
        if (fill?.imageHash) {
            const image = figma.getImageByHash(fill.imageHash);
            if (image) {
                const bytes = await image.getBytesAsync();
                figma.ui.postMessage({ type: 'download-file', bytes: bytes, name: node.name });
            }
        }
    }
};