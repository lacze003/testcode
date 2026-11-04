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

async function callGeminiWithFallback(promptText) {
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
                const result = await model.generateContent(promptText);
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
        } else if (cleanLine.includes('เลขงาน')) {
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
        
        let postData = postDataMap.get(threadId);
        if (!postData) {
            postData = {
                ownerId: message.author.id,
                contents: [message.content],
                botMessage: null,
                isConfirmed: false,
                currentSummary: null,
                pendingUpdateContent: null,
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
                    postData.pendingUpdateContent = message.content;

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
                        content: `📝 **ตรวจพบข้อความเพิ่มเติม:** "${message.content}"\nต้องการกดอัปเดตข้อมูลสรุปงานใหม่ไหมครับ?`,
                        components: [updateRow]
                    });
                } else {
                    postData.contents.push(message.content);
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

    // 🔒 กำหนด ID ของยศ (Role ID) ที่อนุญาตให้กดปุ่มได้
    const allowedRoleIds = ["ใส่_Role_ID_ที่นี่"]; 
    
    const isOwner = interaction.user.id === postData.ownerId;
    const hasAllowedRole = interaction.member && interaction.member.roles.cache.some(role => allowedRoleIds.includes(role.id));

    if (!isOwner && !hasAllowedRole) {
        return interaction.reply({ 
            content: '❌ เฉพาะเจ้าของโพสต์ หรือผู้ที่มีสิทธิ์ (ยศที่กำหนด) เท่านั้นที่มีสิทธิ์กดปุ่มนี้ครับ', 
            ephemeral: true 
        });
    }

    // 1. กดปุ่มยืนยันสรุปงานครั้งแรก
    if (interaction.customId === 'confirm_summary') {
        await interaction.update({
            content: `⏳ **กำลังประมวลผลข้อมูลด้วย AI...**`,
            components: []
        });

        const fullContent = postData.contents.join('\n');

        try {
            const prompt = `วิเคราะห์โพสต์งานโรงกลึงนี้: "${fullContent}"
(หมายเหตุ: คัดกรองและดึงเฉพาะข้อมูลเนื้อหาสาระสำคัญของงาน ตัดทิ้งคำทักทาย ส่วนหัวอีเมล ข้อความแชททั่วไป หรือคำถามที่ไม่เกี่ยวข้องออกให้หมด หากมีรูปภาพแคปหน้าจอแชท LINE หรืออีเมล ให้วิเคราะห์เฉพาะเนื้อหางาน)

วิเคราะห์และดึงข้อมูลตามเงื่อนไขอย่างเคร่งครัด:
1. ชื่อบริษัทลูกค้า: มักเป็นตัวย่อ/ชื่อย่อ (เช่น CGS, GCME, OSC, COA, GME, GCM, GGC PTT LNG, PTTGC, GC, RMS, SAP, SCG, SRI, SYS, SRT, TAS, THAI MMA, TMU, RUNOUN, POS THAINOK, AKS, ATM, BAY, BLCP, BPT, CEM, CHE, COV, CSA, DOWELTECH, DTM, EFF, GLOW, ITT, MOC, MPS, MSS, PAC, POS, PPS) หากไม่มีให้ตอบว่า "ไม่ระบุ"
2. ชื่อลูกค้า: มักจะมีคำว่า "k.", "คุณ", หรือชื่อบุคคลต่อท้าย (เช่น k.สาคร, คุณสาคร, ช่างสาคร) หากไม่มีให้ตอบว่า "ไม่ระบุ"
3. ประเภทงาน: ระบุว่าเป็น "ทำใหม่" หรือ "แก้ไข" หากไม่มีให้ตอบว่า "ไม่ระบุ"
4. กำหนดส่งมอบ: หากในข้อความหรือรูปแชทมีระบุวันส่งหรือคำบอกเวลา เช่น "เอาพรุ่งนี้", "ส่งวันศุกร์", หรือระบุวันที่ ให้ดึงมาตอบที่นี่ แต่ถ้าไม่มีให้ตอบว่า "ไม่ระบุ"
5. เลขงาน: ค้นหาเลขที่ใบงานหรือเลขอ้างอิง (เช่น รูปแบบ 6 หลัก เช่น 260000 หรือรูปแบบ Q เช่น Q26/300) หากไม่พบให้ตอบว่า "ยังไม่มี"
6. รายละเอียดงาน: สรุปเฉพาะรายละเอียดสเปกงานหรือเนื้อหาคำสั่งงานสำคัญๆ เท่านั้น (ตัดคำทักทายออก) หากไม่มีให้ตอบว่า "ไม่ระบุ"

จัดรูปแบบการตอบดังนี้:
- ชื่อบริษัทลูกค้า: [ระบุชื่อบริษัท/ชื่อย่อ หรือ ไม่ระบุ]
- ชื่อลูกค้า: [ระบุชื่อลูกค้า หรือ ไม่ระบุ]
- ประเภทงาน: [ทำใหม่, แก้ไข, หรือ ไม่ระบุ]
- กำหนดส่งมอบ: [ระบุวันส่งมอบ หรือ ไม่ระบุ]
- เลขงาน: [ระบุเลขงาน หรือ ยังไม่มี]
- รายละเอียดงาน: [ระบุรายละเอียดงาน หรือ ไม่ระบุ]`;

            const aiResponse = await callGeminiWithFallback(prompt);
            const parsed = parseAiResponse(aiResponse, fullContent);

            const employeeName = interaction.member ? interaction.member.displayName : interaction.user.username;
            const currentDate = new Date().toISOString().split('T')[0];
            
            // ตั้งชื่อ Thread: หากมีเลขงานให้ใส่เลขงานต่อท้ายด้วย หากยังไม่มีให้ใส่แค่วันที่และบริษัท
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
                    { name: '🔢 เลขงาน', value: parsed.jobNumber, inline: false },
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
- เลขงาน: ${postData.currentSummary.jobNumber}
- รายละเอียดงาน: ${postData.currentSummary.jobDetails}

ข้อความแก้ไขหรือเพิ่มติมที่ส่งมาใหม่: "${postData.pendingUpdateContent}"

จงอัปเดตข้อมูลทั้งหมดให้สอดคล้องกับข้อความใหม่ โดยคงค่าเดิมไว้หากไม่มีการพูดถึงการเปลี่ยนแปลง (กรองเอาเฉพาะเนื้อหางานสำคัญ ตัดคำทักทายออก) หากข้อมูลส่วนไหนไม่มีการระบุ ให้ตอบว่า "ไม่ระบุ" (เฉพาะเลขงานถ้าไม่มีให้ตอบว่า "ยังไม่มี") และจัดรูปแบบการตอบดังนี้:
- ชื่อบริษัทลูกค้า: [ระบุชื่อบริษัท/ชื่อย่อ หรือ ไม่ระบุ]
- ชื่อลูกค้า: [ระบุชื่อลูกค้า หรือ ไม่ระบุ]
- ประเภทงาน: [ทำใหม่, แก้ไข, หรือ ไม่ระบุ]
- กำหนดส่งมอบ: [ระบุวันส่งมอบ หรือ ไม่ระบุ]
- เลขงาน: [ระบุเลขงาน หรือ ยังไม่มี]
- รายละเอียดงาน: [ระบุรายละเอียดงาน หรือ ไม่ระบุ]`;

            const aiResponse = await callGeminiWithFallback(updatePrompt);
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
                    { name: '🔢 เลขงาน', value: parsed.jobNumber, inline: false },
                    { name: '⚙️ รายละเอียดงาน', value: parsed.jobDetails, inline: false }
                )
                .setTimestamp();

            await interaction.channel.send({ embeds: [updatedEmbed] });

            if (postData.updateBotMessage) {
                await postData.updateBotMessage.delete().catch(() => {});
            }

            postData.currentSummary = parsed;
            postData.pendingUpdateContent = null;

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