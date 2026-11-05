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

กฎการอ่านภาพแชท LINE เคร่งครัด:
1. หากเป็นภาพแคปหน้าจอแชท LINE ให้แกะและอ่าน **เฉพาะข้อความตัวอักษร (Text)** ที่คุยกันในแชทเท่านั้น
2. **ห้ามบรรยาย อธิบาย หรือสรุปรายละเอียดเกี่ยวกับรูปถ่ายชิ้นงาน** (เช่น รูปวาล์ว, เฟือง, หรือโครงเหล็ก) ที่ปรากฏในแชทเด็ดขาด ให้ข้ามรูปชิ้นงานไปเลย
3. **ตรวจสอบตัวอักษรภาษาอังกฤษให้เป๊ะ:** ระวังตัวอักษร "i" ตัวเล็กที่ติดหน้าตัวเลข เช่น "ib120" หรือ "ib130" ห้ามอ่านตกเป็น "b120"

เงื่อนไขการสรุปข้อมูล:
1. ชื่อบริษัทลูกค้า: ระบุชื่อบริษัท/สาขา/โซน (เช่น SYS1, GC2, GGC หนองใหญ่ ฯลฯ) หากไม่พบให้ตอบว่า "ไม่ระบุ"
2. ชื่อลูกค้า: ห้ามใช้ชื่อโปรไฟล์ผู้ส่งแชท LINE เว้นแต่ในเนื้อหาข้อความมีการระบุชื่อลูกค้าโดยตรง (เช่น "k.สาคร") หากไม่พบตอบว่า "ไม่ระบุ"
3. ประเภทงาน: 
   - ระบุชื่อชิ้นงานคู่กับประเภทงานให้ชัดเจนว่าชิ้นไหนทำใหม่ ชิ้นไหนแก้ไข (ตัวอย่าง: "ib120 กับ ib130: ทำใหม่ / support 12 ชิ้น: แก้ไข")
   - หากทุกชิ้นงานเป็นประเภทเดียวกันหมด ให้ระบุคำว่า "ทำใหม่" หรือ "แก้ไข" คำเดียวได้เลย
4. กำหนดส่งมอบ: 
   - ระบุชื่อชิ้นงานคู่กับวันส่งมอบให้ชัดเจนว่าชิ้นไหนส่งวันไหน (ตัวอย่าง: "ib120 กับ ib130: วันจันทร์ / support 12 ชิ้น: วันอังคาร")
   - หากส่งวันเดียวกันทุกชิ้น ให้ระบุเฉพาะวันส่งมอบได้เลย (ตัวอย่าง: "วันจันทร์") หากไม่พบตอบว่า "ไม่ระบุ"
5. เลขjob: ระบุเลขที่ใบงาน หากไม่พบตอบว่า "ยังไม่มี"
6. รายละเอียดงาน: รวบรวมสเปกชิ้นงานทั้งหมดที่มีในโพสต์ไว้ที่นี่ (ตัวอย่าง: "ib120, ib130 และ support 12 ชิ้น")

จัดรูปแบบการตอบดังนี้:
- ชื่อบริษัทลูกค้า: [ระบุชื่อบริษัท หรือ ไม่ระบุ]
- ชื่อลูกค้า: [ระบุชื่อลูกค้า หรือ ไม่ระบุ]
- ประเภทงาน: [ระบุชิ้นงานคู่กับประเภทงาน หรือระบุ ทำใหม่/แก้ไข]
- กำหนดส่งมอบ: [ระบุชิ้นงานคู่กับวันส่ง หรือระบุวันส่งมอบ]
- เลขjob: [ระบุเลขjob หรือ ยังไม่มี]
- รายละเอียดงาน: [ระบุรายละเอียดงานทั้งหมด]`;

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
            const allTextCombined = `ข้อมูลเดิม:\n- ชื่อบริษัทลูกค้า: ${postData.currentSummary.companyName}\n- ชื่อลูกค้าเดิม: ${postData.currentSummary.customerName}\n- ประเภทงาน: ${postData.currentSummary.jobType}\n- กำหนดส่งมอบเดิม: ${postData.currentSummary.dueDate}\n- เลขjob: ${postData.currentSummary.jobNumber}\n- รายละเอียดงาน: ${postData.currentSummary.jobDetails}\n\nข้อความหรือข้อมูลใหม่ที่พนักงานพิมพ์เพิ่มเข้ามาในเธรด: "${postData.pendingUpdateContent}"`;

            const updatePrompt = `วิเคราะห์ข้อมูลทั้งหมดเพื่ออัปเดตสรุปงาน:
${allTextCombined}

กฎการอัปเดต:
1. ประเภทงาน: ระบุชิ้นงานคู่กับประเภทงาน เช่น "ib120 กับ ib130: ทำใหม่ / support 12 ชิ้น: แก้ไข" (ถ้าเป็นประเภทเดียวกันหมดใส่แค่ "ทำใหม่" หรือ "แก้ไข")
2. กำหนดส่งมอบ: ระบุชิ้นงานคู่กับวันส่ง เช่น "ib120 กับ ib130: วันจันทร์ / support 12 ชิ้น: วันอังคาร" (ถ้าส่งวันเดียวกันหมดใส่แค่วันส่ง เช่น "วันจันทร์")
3. รายละเอียดงาน: สรุปรายละเอียดสเปกชิ้นงานทั้งหมดรวมไว้ที่นี่
4. คงค่าเดิมไว้หากไม่มีการเปลี่ยนแปลง หากส่วนไหนไม่มีการระบุ ให้ตอบว่า "ไม่ระบุ" (เฉพาะเลขjob ถ้าไม่มีให้ตอบว่า "ยังไม่มี")

จัดรูปแบบการตอบดังนี้:
- ชื่อบริษัทลูกค้า: [ระบุชื่อบริษัท หรือ ไม่ระบุ]
- ชื่อลูกค้า: [ระบุชื่อลูกค้า หรือ ไม่ระบุ]
- ประเภทงาน: [ระบุชิ้นงานคู่กับประเภทงาน หรือระบุ ทำใหม่/แก้ไข]
- กำหนดส่งมอบ: [ระบุชิ้นงานคู่กับวันส่ง หรือระบุวันส่งมอบ]
- เลขjob: [ระบุเลขjob หรือ ยังไม่มี]
- รายละเอียดงาน: [ระบุรายละเอียดงานทั้งหมด]`;

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