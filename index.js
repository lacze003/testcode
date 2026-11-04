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

// ฟังก์ชันหน่วงเวลา (มิลลิวินาที)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// แปลงรูปภาพจาก URL ให้เป็น Buffer สำหรับส่งให้ Gemini อ่าน
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
                
                // รวมข้อความและรูปภาพส่งให้ Gemini วิเคราะห์
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
        if (!postData) {
            postData = {
                ownerId: message.author.id,
                contents: [messagePayload],
                botMessage: null,
                isConfirmed: false,
                currentSummary: null,
                pendingUpdateContent: null,
                pendingUpdateImages: [],
                updateBotMessage: null
            };
            postDataMap.set(threadId, postData);

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('confirm_summary')
                    .setLabel('✅ ยืนยันข้อมูลและสรุปงาน')
                    .setStyle(ButtonStyle.Success)
            );

            postData.botMessage = await message.reply({
                content: `📌 **ข้อมูลครบหรือยัง?** กดยืนยันด้านล่างได้เลย (หากมีเพิ่มพิมพ์ส่งมาได้ครับ)`,
                components: [row]
            });
        } else {
            if (message.author.id === postData.ownerId) {
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
(หมายเหตุ: คัดกรองและดึงเฉพาะข้อมูลเนื้อหาสาระสำคัญของงาน ตัดทิ้งคำทักทาย ส่วนหัวอีเมล ข้อความแชททั่วไป หรือคำถามที่ไม่เกี่ยวข้องออกให้หมด หากเป็นรูปถ่ายชิ้นงานทั่วไปให้เพิกเฉย)

วิเคราะห์และดึงข้อมูลตามเงื่อนไขอย่างเคร่งครัด:
1. ชื่อบริษัทลูกค้า: มักเป็นชื่อย่อหรือชื่อโรงงาน/โซนพื้นที่ต่างๆ ให้ตรวจจับและระบุเลขสาขาหรือโซนติดมาด้วยเสมอ โดยรองรับรูปแบบการเขียนทุกประเภท (ทั้งแบบพิมพ์ติดกัน, เว้นวรรค, หรือมีเครื่องหมายขีด -) ดังนี้:
   - SYS: รองรับ SYS1, SYS 1, SYS-1, SYS2, SYS 2, SYS-2
   - GC: รองรับตั้งแต่ 1 ถึง 19 เช่น GC1 ถึง GC19, GC 1 ถึง GC 19, GC-1 ถึง GC-19, PTT GC-1 ถึง PTT GC-19
   - GGC: รองรับ GGC2, GGC 2, GGC-2, GGC หนองใหญ่, GGC-หนองใหญ่, หรือคำว่า หนองใหญ่
   - หรือบริษัทอื่นๆ (เช่น CGS, GCME, OSC, COA, GME, GCM, PTT LNG, PTTGC, RMS, SAP, SCG, SRI, SRT, TAS, THAI MMA, TMU, RUNOUN, POS THAINOK, AKS, ATM, BAY, BLCP, BPT, CEM, CHE, COV, CSA, DOWELTECH, DTM, EFF, GLOW, ITT, MOC, MPS, MSS, PAC, POS, PPS) หากไม่มีให้ตอบว่า "ไม่ระบุ"
2. ชื่อลูกค้า: มักจะมีคำว่า "k.", "คุณ", หรือชื่อบุคคลต่อท้าย (เช่น k.สาคร, คุณสาคร, ช่างสาคร) **หากข้อมูลหรือภาพถ่ายมาจากแชท LINE ให้ไม่ต้องเก็บชื่อลูกค้า และตอบว่า "ไม่ระบุ" ทันที** หากเป็นช่องทางอื่นและไม่มีให้ตอบว่า "ไม่ระบุ"
3. ประเภทงาน: ระบุว่าเป็น "ทำใหม่" หรือ "แก้ไข" หากไม่มีให้ตอบว่า "ไม่ระบุ"
4. กำหนดส่งมอบ: หากในข้อความหรือรูปแชทมีระบุวันส่งหรือคำบอกเวลา เช่น "เอาพรุ่งนี้", "ส่งวันศุกร์", หรือระบุวันที่ ให้ดึงมาตอบที่นี่ แต่ถ้าไม่มีให้ตอบว่า "ไม่ระบุ"
5. เลขjob: ค้นหาเลขที่ใบงานหรือเลขอ้างอิง (เช่น รูปแบบ 6 หลัก เช่น 260000 หรือรูปแบบ Q เช่น Q26/300) หากไม่พบให้ตอบว่า "ยังไม่มี"
6. รายละเอียดงาน: สรุปเฉพาะรายละเอียดสเปกงานหรือเนื้อหาคำสั่งงานสำคัญๆ เท่านั้น (ตัดคำทักทายออก) หากไม่มีให้ตอบว่า "ไม่ระบุ"

จัดรูปแบบการตอบดังนี้:
- ชื่อบริษัทลูกค้า: [ระบุชื่อบริษัท/ชื่อย่อ/โซน/สาขา หรือ ไม่ระบุ]
- ชื่อลูกค้า: [ระบุชื่อลูกค้า หรือ ไม่ระบุ]
- ประเภทงาน: [ทำใหม่, แก้ไข, หรือ ไม่ระบุ]
- กำหนดส่งมอบ: [ระบุวันส่งมอบ หรือ ไม่ระบุ]
- เลขjob: [ระบุเลขjob หรือ ยังไม่มี]
- รายละเอียดงาน: [ระบุรายละเอียดงาน หรือ ไม่ระบุ]`;

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

    // 2. กดปุ่มยืนยันอัปเดตข้อมูลเพิ่มเติม
    if (interaction.customId === 'confirm_update') {
        await interaction.update({
            content: `⏳ **กำลังอัปเดตสรุปข้อมูลด้วย AI...**`,
            components: []
        });

        try {
            const updatePrompt = `ข้อมูลสรุปเดิม:
- ชื่อบริษัทลูกค้า: ${postData.currentSummary.companyName}
- ชื่อลูกค้า: ${postData.currentSummary.customerName}
- ประเภทงาน: ${postData.currentSummary.jobType}
- กำหนดส่งมอบ: ${postData.currentSummary.dueDate}
- เลขjob: ${postData.currentSummary.jobNumber}
- รายละเอียดงาน: ${postData.currentSummary.jobDetails}

ข้อความ/รูปภาพแก้ไขหรือเพิ่มเติมที่ส่งมาใหม่: "${postData.pendingUpdateContent}"

จงอัปเดตข้อมูลทั้งหมดให้สอดคล้องกับข้อความใหม่ โดยคงค่าเดิมไว้หากไม่มีการพูดถึงการเปลี่ยนแปลง (หากมาจากแชท LINE ให้คงชื่อลูกค้าเป็น "ไม่ระบุ") หากข้อมูลส่วนไหนไม่มีการระบุ ให้ตอบว่า "ไม่ระบุ" (เฉพาะเลขjob ถ้าไม่มีให้ตอบว่า "ยังไม่มี") และจัดรูปแบบการตอบดังนี้:
- ชื่อบริษัทลูกค้า: [ระบุชื่อบริษัท/ชื่อย่อ/โซน/สาขา หรือ ไม่ระบุ]
- ชื่อลูกค้า: [ระบุชื่อลูกค้า หรือ ไม่ระบุ]
- ประเภทงาน: [ทำใหม่, แก้ไข, หรือ ไม่ระบุ]
- กำหนดส่งมอบ: [ระบุวันส่งมอบ หรือ ไม่ระบุ]
- เลขjob: [ระบุเลขjob หรือ ยังไม่มี]
- รายละเอียดงาน: [ระบุรายละเอียดงาน หรือ ไม่ระบุ]`;

            const aiResponse = await callGeminiWithFallback(updatePrompt, postData.pendingUpdateImages);
            const parsed = parseAiResponse(aiResponse, postData.currentSummary.jobDetails);

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