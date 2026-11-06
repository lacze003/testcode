require('dotenv').config();
const express = require('express');
const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle 
} = require('discord.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Machining Owner Bot is online!');
});

app.listen(PORT, () => {
    console.log(`Owner Server listening on port ${PORT}`);
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function urlToGenerativePart(url, mimeType) {
    try {
        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer();
        return {
            inlineData: {
                data: Buffer.from(arrayBuffer).toString("base64"),
                mimeType
            },
        };
    } catch (error) {
        console.error("Error fetching image for Gemini:", error);
        return null;
    }
}

async function callGeminiWithFallback(promptText, imageParts = []) {
    const apiKeys = [
        process.env.GEMINI_API_KEY_1,
        process.env.GEMINI_API_KEY_2,
        process.env.GEMINI_API_KEY_3
    ].filter(Boolean);

    if (apiKeys.length === 0) {
        throw new Error("ยังไม่ได้ตั้งค่า GEMINI_API_KEY ใน Environment Variables ของ Render");
    }

    const modelsToTry = [
        "gemini-3.5-flash-lite",
        "gemini-3.8-flash"
    ];
    
    let lastError = null;

    for (const modelName of modelsToTry) {
        for (let i = 0; i < apiKeys.length; i++) {
            try {
                console.log(`กำลังเรียกใช้ ${modelName} ด้วย Key ที่ ${i + 1}...`);
                const genAI = new GoogleGenerativeAI(apiKeys[i]);
                const model = genAI.getGenerativeModel({ model: modelName });
                
                const contents = [promptText, ...imageParts];
                const result = await model.generateContent(contents);
                const response = await result.response;
                return response.text();
            } catch (error) {
                console.warn(`⚠️ ${modelName} (Key ${i + 1}) ล้มเหลว:`, error.message);
                lastError = error;
                await sleep(2000);
            }
        }
    }
    throw new Error(`Gemini API ล้มเหลวทุก Key และทุก Model: ${lastError ? lastError.message : 'Unknown error'}`);
}

function parseAiResponse(aiResponse, fallbackDetails) {
    let companyName = "ไม่ระบุ";
    let customerName = "ไม่ระบุ";
    let jobType = "ไม่ระบุ";
    let dueDate = "ไม่ระบุ";
    let jobNumber = "ยังไม่มี";
    let jobDetails = fallbackDetails || "ไม่ระบุ";

    const lines = aiResponse.split('\n');
    for (const line of lines) {
        const cleanLine = line.replace(/[*_`]/g, '').trim();
        if (cleanLine.includes('ชื่อบริษัทลูกค้า')) {
            const parts = cleanLine.split(':');
            if (parts[1] && parts[1].trim() && parts[1].trim() !== '-') companyName = parts[1].trim();
        } else if (cleanLine.includes('ชื่อลูกค้า')) {
            const parts = cleanLine.split(':');
            if (parts[1] && parts[1].trim() && parts[1].trim() !== '-') customerName = parts[1].trim();
        } else if (cleanLine.includes('ประเภทงาน')) {
            const parts = cleanLine.split(':');
            if (parts[1] && parts[1].trim() && parts[1].trim() !== '-') jobType = parts[1].trim();
        } else if (cleanLine.includes('กำหนดส่งมอบ')) {
            const parts = cleanLine.split(':');
            if (parts[1] && parts[1].trim() && parts[1].trim() !== '-') dueDate = parts[1].trim();
        } else if (cleanLine.includes('เลขjob')) {
            const parts = cleanLine.split(':');
            if (parts[1] && parts[1].trim() && parts[1].trim() !== '-' && parts[1].trim() !== 'ยังไม่มี') jobNumber = parts[1].trim();
        } else if (cleanLine.includes('รายละเอียดงาน')) {
            const parts = cleanLine.split(':');
            if (parts[1] && parts[1].trim() && parts[1].trim() !== '-') jobDetails = parts[1].trim();
        }
    }

    return { companyName, customerName, jobType, dueDate, jobNumber, jobDetails };
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const postDataMap = new Map();

client.once('ready', () => {
    console.log(`Owner Bot Logged in as ${client.user.tag}!`);
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    if (message.channel.isThread()) {
        const threadId = message.channel.id;
        
        let messagePayload = {
            content: message.content || "",
            images: []
        };

        if (message.attachments.size > 0) {
            for (const attachment of message.attachments.values()) {
                if (attachment.contentType && attachment.contentType.startsWith('image/')) {
                    const imagePart = await urlToGenerativePart(attachment.url, attachment.contentType);
                    if (imagePart) {
                        messagePayload.images.push(imagePart);
                    }
                }
            }
        }
        
        let postData = postDataMap.get(threadId);
        
        // ถ้าไม่มีข้อมูลใน Map (เช่น บอทเพิ่งรีสตาร์ทใหม่) ให้ลองเช็คย้อนหลังในแชทดูก่อนว่าเคยมีการ์ดสรุปงานหรือยัง
        if (!postData) {
            let hasBeenConfirmed = false;
            try {
                const recentMsgs = await message.channel.messages.fetch({ limit: 20 });
                for (const m of recentMsgs.values()) {
                    if (m.author.id === client.user.id && m.embeds.length > 0) {
                        if (m.embeds[0].title && m.embeds[0].title.includes('สรุปข้อมูลงาน')) {
                            hasBeenConfirmed = true;
                            break;
                        }
                    }
                }
            } catch (e) {
                console.error("Error checking past messages:", e);
            }

            postData = {
                ownerId: message.author.id,
                contents: [messagePayload],
                botMessage: null,
                isConfirmed: hasBeenConfirmed, // ถ้าเจอการ์ดเก่า แปลว่ายืนยันแล้ว
                currentSummary: null,
                pendingUpdateContent: null,
                pendingUpdateImages: [],
                updateBotMessage: null
            };
            postDataMap.set(threadId, postData);
        }

        if (message.author.id === postData.ownerId) {
            // เช็คสถานะ: ถ้ายืนยันไปแล้ว (หรือเคยมีสรุปเก่าในแชทแล้ว) ให้ถือเป็นการ "อัปเดตข้อมูล"
            if (postData.isConfirmed) {
                postData.pendingUpdateContent = messagePayload.content;
                postData.pendingUpdateImages = messagePayload.images;

                const updateRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('confirm_update')
                        .setLabel('🔄 อัปเดตข้อมูลสรุป')
                        .setStyle(ButtonStyle.Primary)
                );

                if (postData.updateBotMessage) {
                    await postData.updateBotMessage.delete().catch(() => {});
                }

                postData.updateBotMessage = await message.reply({
                    content: `📝 **ตรวจพบข้อความ/รูปภาพเพิ่มเติม** ต้องการกดอัปเดตข้อมูลสรุปงานใหม่ไหมครับ?`,
                    components: [updateRow]
                });
            } else {
                postData.contents.push(messagePayload);
            }
        }
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    const threadId = interaction.channel.id;
    const postData = postDataMap.get(threadId);

    if (!postData) {
        return interaction.reply({ 
            content: '❌ ไม่พบข้อมูลโพสต์นี้ในระบบ กรุณาลองใหม่อีกครั้ง', 
            ephemeral: true 
        });
    }

    const isOwner = interaction.user.id === postData.ownerId;
    const hasSummaryRole = interaction.member && interaction.member.roles.cache.some(role => role.name.toLowerCase() === 'summary');

    if (!isOwner && !hasSummaryRole) {
        return interaction.reply({ 
            content: '❌ เฉพาะเจ้าของโพสต์ หรือผู้ที่มีมีสิทธิ์กดปุ่มนี้ครับ', 
            ephemeral: true 
        });
    }

    // 1. กดปุ่มยืนยันสรุปงานครั้งแรก
    if (interaction.customId === 'confirm_summary') {
        await interaction.update({
            content: `⏳ **กำลังประมวลผลข้อมูลและรูปภาพด้วย AI...**`,
            components: []
        });

        const textContents = postData.contents.map(c => c.content).filter(Boolean).join('\n');
        const allImages = postData.contents.flatMap(c => c.images);

        try {
            const prompt = `วิเคราะห์โพสต์งานโรงกลึงจากข้อความและรูปภาพที่แนบมานี้: "${textContents}"

กฎการอ่านภาพแชท LINE เคร่งครัด:
1. หากเป็นภาพแคปหน้าจอแชท LINE ให้แกะและอ่าน **เฉพาะข้อความตัวอักษร (Text)** ที่คุยกันในแชทเท่านั้น
​2. **ห้ามบรรยาย อธิบาย หรือสรุปรายละเอียดเกี่ยวกับรูปถ่ายชิ้นงาน** ให้ข้ามรูปชิ้นงานไปเลย
3. **ตรวจสอบตัวอักษรภาษาอังกฤษให้เป๊ะ:** เช่น "ib120" หรือ "ib130" ห้ามอ่านตกตัว "i" เป็น "b120"

เงื่อนไขการคัดแยกและระบุรูปแบบข้อมูล:
1. ชื่อบริษัทลูกค้า: มักเป็นชื่อย่อหรือชื่อโรงงาน/โซนพื้นที่ต่างๆ ให้ตรวจจับและระบุเลขสาขาหรือโซนติดมาด้วยเสมอ โดยรองรับรูปแบบการเขียนทุกประเภท ดังนี้:
   - SYS: รองรับ SYS, SYS1, SYS 1, SYS-1, SYS2, SYS 2, SYS-2
   - GC: รองรับตั้งแต่ GC,GC1 ถึง 19 เช่น GC1 ถึง GC19, GC 1 ถึง GC 19, GC-1 ถึง GC-19, PTT GC-1 ถึง PTT GC-19
   - GGC: รองรับ GGC, GGC2, GGC 2, GGC-2, GGC หนองใหญ่, GGC-หนองใหญ่, หรือคำว่า หนองใหญ่
   - หรือบริษัทอื่นๆ (เช่น CGS, GCME, OSC, COA, GME, GCM, PTT LNG, PTTGC, RMS, SAP, SCG, SRI, SRT, TAS, THAI MMA, TMU, RUNOUN, POS THAINOK, AKS, ATM, BAY, BLCP, BPT, CEM, CHE, COV, CSA, DOWELTECH, DTM, EFF, GLOW, ITT, MOC, MPS, MSS, PAC, POS, PPS) หากไม่มีให้ตอบว่า "ไม่ระบุ"
2. ชื่อลูกค้า: ห้ามใช้ชื่อโปรไฟล์ผู้ส่งแชท LINE เว้นแต่มีการพิมพ์ระบุชื่อลูกค้าไว้ในข้อความโดยตรง (เช่น "k.สาคร") หากไม่พบตอบว่า "ไม่ระบุ"
3. ประเภทงาน: ระบุว่าเป็น "ทำใหม่" หรือ "แก้ไข" หากไม่มีให้ตอบว่า "ไม่ระบุ"
4. กำหนดส่งมอบ: หากในข้อความหรือรูปแชทมีระบุวันส่งหรือคำบอกเวลา เช่น "เอาพรุ่งนี้", "ส่งวันศุกร์", หรือระบุวันที่ ให้ดึงมาตอบที่นี่ แต่ถ้าไม่มีให้ตอบว่า "ไม่ระบุ" ถ้ามีงานมากกว่า 1 อย่าง ให้ระบุรายละเอียด งานนั้นคู่กับวันที่ส่งมาด้วย
5. เลขjob: ค้นหาเลขที่ใบงานหรือเลขอ้างอิง (เช่น รูปแบบ 6 หลัก เช่น 260000, 270000, 280000, JOB260000  หรือรูปแบบ Q เช่น Q26/300) หากไม่พบให้ตอบว่า "ยังไม่มี"
6. รายละเอียดงาน: **บังคับต้องรวบรวมชื่อชิ้นงานและสเปกทั้งหมด**  มาใส่ไว้ที่ช่องนี้เสมอ ห้ามปล่อยว่างเด็ดขาด!

จัดรูปแบบการตอบดังนี้:
- ชื่อบริษัทลูกค้า: [ระบุชื่อบริษัท หรือ ไม่ระบุ]
- ชื่อลูกค้า: [ระบุชื่อลูกค้า หรือ ไม่ระบุ]
- ประเภทงาน: [ทำใหม่, แก้ไข, หรือ ไม่ระบุ]
- กำหนดส่งมอบ: [ระบุวันส่งมอบ หรือ ไม่ระบุ]
- เลขjob: [ระบุเลขjob หรือ ยังไม่มี]
- รายละเอียดงาน: [ระบุชื่อชิ้นงานและสเปกทั้งหมดที่พบ ห้ามว่าง]`;

            const aiResponse = await callGeminiWithFallback(prompt, allImages);
            const parsed = parseAiResponse(aiResponse, textContents);

            const employeeName = interaction.member ? interaction.member.displayName : interaction.user.username;
            const currentDate = new Date().toISOString().split('T')[0];
            
            let newThreadName = `${currentDate} - ${parsed.companyName !== "ไม่ระบุ" ? parsed.companyName : "งานใหม่"}`;
            if (parsed.jobNumber !== "ยังไม่มี") {
                newThreadName += ` - ${parsed.jobNumber}`;
            }

            try {
                await interaction.channel.setName(newThreadName);
            } catch (error) {
                console.error('ไม่สามารถเปลี่ยนชื่อ Thread ได้:', error);
            }

            const summaryEmbed = new EmbedBuilder()
                .setTitle('📋 สรุปข้อมูลงาน')
                .setColor(0x00FF00)
                .addFields(
                    { name: '🏢 ชื่อบริษัทลูกค้า', value: parsed.companyName, inline: false },
                    { name: '👤 ชื่อลูกค้า', value: parsed.customerName, inline: false },
                    { name: '👨‍💻 ชื่อพนักงาน (ผู้บันทึก)', value: employeeName, inline: false },
                    { name: '📌 ประเภทงาน', value: parsed.jobType, inline: false },
                    { name: '📅 กำหนดส่งมอบ', value: parsed.dueDate, inline: false },
                    { name: '🔢 เลขjob', value: parsed.jobNumber, inline: false },
                    { name: '⚙️ รายละเอียดงาน', value: parsed.jobDetails, inline: false }
                )
                .setTimestamp();

            await interaction.channel.send({ embeds: [summaryEmbed] });

            if (postData.botMessage) {
                await postData.botMessage.delete().catch(() => {});
            }

            postData.isConfirmed = true;
            postData.currentSummary = parsed;

        } catch (err) {
            console.error("Summary Error:", err);
            
            await interaction.followUp({ 
                content: `❌ เกิดข้อผิดพลาด: ${err.message}`, 
                ephemeral: true 
            });

            if (postData.botMessage) {
                const retryRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('confirm_summary')
                        .setLabel('✅ ยืนยันข้อมูลและสรุปงาน')
                        .setStyle(ButtonStyle.Success)
                );
                await interaction.editReply({
                    content: `❌ **เกิดข้อผิดพลาดในการประมวลผล:** ${err.message}\n(สามารถกดยืนยันใหม่อีกครั้งได้เลยครับ)`,
                    components: [retryRow]
                }).catch(() => {});
            }
        }
    }

    // 2. กดปุ่มยืนยันอัปเดตข้อมูลเพิ่มเติม (ดึงข้อมูลจาก Embed ล่าสุดในแชทโดยตรง ป้องกันบอทรีสตาร์ทลืมค่า)
    if (interaction.customId === 'confirm_update') {
        await interaction.update({
            content: `⏳ **กำลังดึงข้อมูลจากสรุปอันล่าสุดมาอัปเดตด้วย AI...**`,
            components: []
        });

        try {
            let latestSummaryData = {
                companyName: "ไม่ระบุ",
                customerName: "ไม่ระบุ",
                jobType: "ไม่ระบุ",
                dueDate: "ไม่ระบุ",
                jobNumber: "ยังไม่มี",
                jobDetails: "ไม่ระบุ"
            };

            const messages = await interaction.channel.messages.fetch({ limit: 100 });
            for (const msg of messages.values()) {
                if (msg.author.id === client.user.id && msg.embeds.length > 0) {
                    const embed = msg.embeds[0];
                    if (embed.title && embed.title.includes('สรุปข้อมูลงาน')) {
                        for (const field of embed.fields) {
                            if (field.name.includes('ชื่อบริษัทลูกค้า')) latestSummaryData.companyName = field.value;
                            if (field.name.includes('ชื่อลูกค้า')) latestSummaryData.customerName = field.value;
                            if (field.name.includes('ประเภทงาน')) latestSummaryData.jobType = field.value;
                            if (field.name.includes('กำหนดส่งมอบ')) latestSummaryData.dueDate = field.value;
                            if (field.name.includes('เลขjob')) latestSummaryData.jobNumber = field.value;
                            if (field.name.includes('รายละเอียดงาน')) latestSummaryData.jobDetails = field.value;
                        }
                        break;
                    }
                }
            }

            const allTextCombined = `ข้อมูลเดิมจากสรุปอันล่าสุดในแชท:
- ชื่อบริษัทลูกค้า: ${latestSummaryData.companyName}
- ชื่อลูกค้าเดิม: ${latestSummaryData.customerName}
- ประเภทงาน: ${latestSummaryData.jobType}
- กำหนดส่งมอบเดิม: ${latestSummaryData.dueDate}
- เลขjob: ${latestSummaryData.jobNumber}
- รายละเอียดงาน: ${latestSummaryData.jobDetails}

ข้อความหรือข้อมูลใหม่ที่พนักงานพิมพ์เพิ่มเข้ามาในเธรด: "${postData.pendingUpdateContent}"`;

            const updatePrompt = `วิเคราะห์ข้อมูลทั้งหมดเพื่ออัปเดตสรุปงาน:
${allTextCombined}

กฎการอัปเดต:
1. นำข้อมูลจากสรุปอันล่าสุดมาเป็นหลัก ห้ามทำให้ข้อมูลเก่าหายไปเด็ดขาด
2. ชื่อบริษัทลูกค้า: มักเป็นชื่อย่อหรือชื่อโรงงาน/โซนพื้นที่ต่างๆ ให้ตรวจจับและระบุเลขสาขาหรือโซนติดมาด้วยเสมอ โดยรองรับรูปแบบการเขียนทุกประเภท ดังนี้:
   - SYS: รองรับ SYS, SYS1, SYS 1, SYS-1, SYS2, SYS 2, SYS-2
   - GC: รองรับตั้งแต่ GC,GC1 ถึง 19 เช่น GC1 ถึง GC19, GC 1 ถึง GC 19, GC-1 ถึง GC-19, PTT GC-1 ถึง PTT GC-19
   - GGC: รองรับ GGC, GGC2, GGC 2, GGC-2, GGC หนองใหญ่, GGC-หนองใหญ่, หรือคำว่า หนองใหญ่
   - หรือบริษัทอื่นๆ (เช่น CGS, GCME, OSC, COA, GME, GCM, PTT LNG, PTTGC, RMS, SAP, SCG, SRI, SRT, TAS, THAI MMA, TMU, RUNOUN, POS THAINOK, AKS, ATM, BAY, BLCP, BPT, CEM, CHE, COV, CSA, DOWELTECH, DTM, EFF, GLOW, ITT, MOC, MPS, MSS, PAC, POS, PPS) หากไม่มีให้ตอบว่า "ไม่ระบุ"
3. ชื่อลูกค้า: ห้ามใช้ชื่อโปรไฟล์ผู้ส่งแชท LINE เว้นแต่มีการพิมพ์ระบุชื่อลูกค้าไว้ในข้อความโดยตรง (เช่น "k.สาคร") หากไม่พบตอบว่า "ไม่ระบุ"
4. ประเภทงาน: ระบุว่าเป็น "ทำใหม่" หรือ "แก้ไข" หากไม่มีให้ตอบว่า "ไม่ระบุ"
5. กำหนดส่งมอบ: หากในข้อความหรือรูปแชทมีระบุวันส่งหรือคำบอกเวลา เช่น "เอาพรุ่งนี้", "ส่งวันศุกร์", หรือระบุวันที่ ให้ดึงมาตอบที่นี่ แต่ถ้าไม่มีให้ตอบว่า "ไม่ระบุ" ถ้ามีงานมากกว่า 1 อย่าง ให้ระบุรายละเอียด งานนั้นคู่กับวันที่ส่งมาด้วย
6. เลขjob: ค้นหาเลขที่ใบงานหรือเลขอ้างอิง (เช่น รูปแบบ 6 หลัก เช่น 260000, 270000, 280000, JOB260000  หรือรูปแบบ Q เช่น Q26/300) หากไม่พบให้ตอบว่า "ยังไม่มี"
7. รายละเอียดงาน: **บังคับต้องรวบรวมชื่อชิ้นงานและสเปกทั้งหมด** มาใส่ไว้ที่ช่องนี้เสมอ ห้ามปล่อยว่างเด็ดขาด!

จัดรูปแบบการตอบดังนี้:
- ชื่อบริษัทลูกค้า: [ระบุชื่อบริษัทเดิมหรือที่อัปเดต]
- ชื่อลูกค้า: [ระบุชื่อลูกค้าเดิมหรือที่อัปเดต]
- ประเภทงาน: [ระบุประเภทงานเดิมหรือที่อัปเดต]
- กำหนดส่งมอบ: [ระบุวันส่งมอบเดิมหรือที่อัปเดต]
- เลขjob: [ระบุเลขjob เดิมหรือที่อัปเดต]
- รายละเอียดงาน: [ระบุรายละเอียดงานเดิมและใหม่รวมกัน ห้ามว่าง]`;

            const aiResponse = await callGeminiWithFallback(updatePrompt, postData.pendingUpdateImages);
            const parsed = parseAiResponse(aiResponse, latestSummaryData.jobDetails);

            const currentDate = new Date().toISOString().split('T')[0];
            let newThreadName = `${currentDate} - ${parsed.companyName !== "ไม่ระบุ" ? parsed.companyName : "งานอัปเดต"}`;
            if (parsed.jobNumber !== "ยังไม่มี") {
                newThreadName += ` - ${parsed.jobNumber}`;
            }

            try {
                await interaction.channel.setName(newThreadName);
            } catch (error) {
                console.error('ไม่สามารถเปลี่ยนชื่อ Thread ได้:', error);
            }

            const employeeName = interaction.member ? interaction.member.displayName : interaction.user.username;

            const updatedEmbed = new EmbedBuilder()
                .setTitle('📋 สรุปข้อมูลงาน (อัปเดต)')
                .setColor(0x00FF00)
                .addFields(
                    { name: '🏢 ชื่อบริษัทลูกค้า', value: parsed.companyName, inline: false },
                    { name: '👤 ชื่อลูกค้า', value: parsed.customerName, inline: false },
                    { name: '👨‍💻 ชื่อพนักงาน (ผู้บันทึก)', value: employeeName, inline: false },
                    { name: '📌 ประเภทงาน', value: parsed.jobType, inline: false },
                    { name: '📅 กำหนดส่งมอบ', value: parsed.dueDate, inline: false },
                    { name: '🔢 เลขjob', value: parsed.jobNumber, inline: false },
                    { name: '⚙️ รายละเอียดงาน', value: parsed.jobDetails, inline: false }
                )
                .setTimestamp();

            await interaction.channel.send({ embeds: [updatedEmbed] });

            if (postData.updateBotMessage) {
                await postData.updateBotMessage.delete().catch(() => {});
            }

            postData.currentSummary = parsed;
            postData.pendingUpdateContent = null;
            postData.pendingUpdateImages = [];

        } catch (err) {
            console.error("Update Error:", err);
            
            await interaction.followUp({ 
                content: `❌ เกิดข้อผิดพลาดในการอัปเดต: ${err.message}`, 
                ephemeral: true 
            });

            if (postData.updateBotMessage) {
                const retryUpdateRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('confirm_update')
                        .setLabel('🔄 อัปเดตข้อมูลสรุป')
                        .setStyle(ButtonStyle.Primary)
                );
                await interaction.editReply({
                    content: `❌ **เกิดข้อผิดพลาดในการอัปเดต:** ${err.message}\n(สามารถกดปุ่มอัปเดตใหม่อีกครั้งได้เลยครับ)`,
                    components: [retryUpdateRow]
                }).catch(() => {});
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN);