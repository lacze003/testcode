require('dotenv').config();
const express = require('express');
const { 
    Client, 
    GatewayIntentBits, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle 
} = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Machining Helper Bot 2 is online!');
});

app.listen(PORT, () => {
    console.log(`Helper Bot 2 Server listening on port ${PORT}`);
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// เก็บข้อมูลเจ้าของเธรดแต่ละโพสต์
const threadOwnerMap = new Map();

client.once('ready', () => {
    console.log(`Helper Bot 2 Logged in as ${client.user.tag}!`);
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    if (message.channel.isThread()) {
        const threadId = message.channel.id;
        
        // บันทึกเจ้าของโพสต์ (ถ้ายังไม่มี)
        if (!threadOwnerMap.has(threadId)) {
            threadOwnerMap.set(threadId, message.author.id);
        }

        // ตรวจสอบว่าในเธรดนี้เคยมีปุ่มกดของบอทส่งไปแล้วหรือยัง (ป้องกันปุ่มเด้งซ้ำ)
        let hasButtonsAlready = false;
        try {
            const fetchedMsgs = await message.channel.messages.fetch({ limit: 20 });
            for (const m of fetchedMsgs.values()) {
                if (m.author.id === client.user.id && m.components && m.components.length > 0) {
                    hasButtonsAlready = true;
                    break;
                }
            }
        } catch (err) {
            console.error("Error checking existing buttons:", err);
        }

        // ถ้ายังไม่เคยมีปุ่ม ให้ส่งชุดปุ่มขึ้นมาครั้งเดียว
        if (!hasButtonsAlready) {
            const askRow1 = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('ask_job_details_bot2')
                    .setLabel('📋 ขอรายละเอียดข้อมูลที่ไม่ครบหน่อยครับ')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('ask_missing_info_bot2')
                    .setLabel('🏢 บริษัทอะไร')
                    .setStyle(ButtonStyle.Secondary)
            );

            const askRow2 = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('ask_company_bot2')
                    .setLabel('❓ งานทำใหม่หรือแก้ไข')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('ask_type_duedate_bot2')
                    .setLabel('📌 กำหนดส่งวันไหน')
                    .setStyle(ButtonStyle.Secondary)
            );

            await message.reply({
                content: `💬 **หากต้องการสอบถามข้อมูลเพิ่มเติมจากเจ้าของโพสต์** สามารถเลือกกดปุ่มด้านล่างได้เลยครับ`,
                components: [askRow1, askRow2]
            });
        }

        // ตรวจสอบการส่งไฟล์ และรวมยอดจำนวนไฟล์ในเธรดแบบดึงข้อความจริงมาบวกสะสม
        if (message.attachments.size > 0) {
            try {
                // ดึงประวัติข้อความล่าสุดในเธรดมาเช็ค
                const fetchedMsgs = await message.channel.messages.fetch({ limit: 30 });
                let existingAlertMsg = null;
                let currentTotalFiles = message.attachments.size;
                let currentPdfCount = 0;

                // เช็คจำนวน PDF ในข้อความปัจจุบันที่เพิ่งส่ง
                for (const att of message.attachments.values()) {
                    const url = att.url.toLowerCase();
                    const contentType = (att.contentType || "").toLowerCase();
                    if (url.endsWith('.pdf') || contentType.includes('pdf')) {
                        currentPdfCount++;
                    }
                }

                // ค้นหาข้อความแจ้งเตือนไฟล์ล่าสุดของบอทในแชท
                for (const m of fetchedMsgs.values()) {
                    if (m.author.id === client.user.id && m.content.includes('แจ้งเตือนจากระบบ:')) {
                        existingAlertMsg = m;
                        
                        // ดึงตัวเลขยอดรวมเก่าจากข้อความเดิม (รองรับทั้งแบบรวมทั้งหมด และแบบตัวเลขเดี่ยว)
                        const matchTotal = m.content.match(/รวมทั้งหมด (\d+) ไฟล์/) || m.content.match(/มา (\d+) ไฟล์/);
                        if (matchTotal) {
                            currentTotalFiles += parseInt(matchTotal[1], 10);
                        }

                        // ดึงจำนวน PDF เก่ามาบวกเพิ่ม (ถ้ามี)
                        const matchPdf = m.content.match(/ตัว PDF มา (\d+) ไฟล์/);
                        if (matchPdf) {
                            currentPdfCount += parseInt(matchPdf[1], 10);
                        }
                        break; // เจอข้อความแจ้งเตือนล่าสุดแล้ว หยุดหาทันที
                    }
                }

                let alertText = `📎 **แจ้งเตือนจากระบบ**: มีการส่งไฟล์งานมา ${currentTotalFiles} ไฟล์ครับ`;
                if (currentPdfCount > 0) {
                    alertText = `📎 **แจ้งเตือนจากระบบ**: มีการส่งตัว PDF มา ${currentPdfCount} ไฟล์ครับ (รวมทั้งหมด ${currentTotalFiles} ไฟล์)`;
                }

                // ลบข้อความแจ้งเตือนอันเก่าทิ้งทันที
                if (existingAlertMsg) {
                    await existingAlertMsg.delete().catch(() => {});
                }

                // ส่งข้อความแจ้งเตือนยอดรวมใหม่ลงในเธรด
                await message.channel.send({
                    content: alertText
                });

            } catch (err) {
                console.error("Error updating file count alert:", err);
            }
        }
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    const threadId = interaction.channel.id;
    const ownerId = threadOwnerMap.get(threadId);

    let requestMessageText = '';

    if (interaction.customId === 'ask_job_details_bot2') {
        requestMessageText = '**ขอรายละเอียดข้อมูลที่ไม่ครบหน่อยครับ**';
    } else if (interaction.customId === 'ask_missing_info_bot2') {
        requestMessageText = '**เป็นงานของบริษัทอะไรครับ?**';
    } else if (interaction.customId === 'ask_company_bot2') {
        requestMessageText = '**งานนี้เป็นงานทำใหม่หรือแก้ไขครับ?**';
    } else if (interaction.customId === 'ask_type_duedate_bot2') {
        requestMessageText = '**กำหนดส่งวันไหนครับ?**';
    } else {
        return;
    }

    // แจ้งเตือนคนกดแบบเห็นคนเดียว (Ephemeral)
    await interaction.reply({ 
        content: '✅ ส่งข้อความแจ้งเตือนไปยังเจ้าของโพสต์เรียบร้อยแล้วครับ', 
        ephemeral: true 
    });

    // ส่งข้อความแท็กเรียกเจ้าของโพสต์ในเธรดสาธารณะ (เมื่อมีการกดปุ่ม)
    if (ownerId) {
        await interaction.channel.send({
            content: `📢 <@${ownerId}> ${requestMessageText}`
        });
    } else {
        await interaction.channel.send({
            content: `📢 **เจ้าของโพสต์ครับ**: ${requestMessageText}`
        });
    }
});

client.login(process.env.DISCORD_TOKEN);
client.login(process.env.DISCORD_TOKEN);