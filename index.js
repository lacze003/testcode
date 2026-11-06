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
        
        // ถ้าเป็นข้อความแรกในเธรด ให้บันทึกเจ้าของโพสต์และส่งชุดปุ่มสอบถาม
        if (!threadOwnerMap.has(threadId)) {
            threadOwnerMap.set(threadId, message.author.id);

            const askRow1 = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('ask_job_details_bot2')
                    .setLabel('📋 ขอรายละเอียดข้อมูลที่ไม่ครบหน่อยครับ')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('ask_missing_info_bot2')
                    .setLabel('🏢 บริษัทอะไร ')
                    .setStyle(ButtonStyle.Secondary)
            );

            const askRow2 = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('ask_company_bot2')
                    .setLabel('❓ งานทำใหม่หรือแก้ไข /')
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
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    const threadId = interaction.channel.id;
    const ownerId = threadOwnerMap.get(threadId);

    let requestMessageText = '';

    if (interaction.customId === 'ask_job_details_bot2') {
        requestMessageText = '**ขอรายละเอียดข้อมูลที่ไม่ครบหน่อยครับ?**';
    } else if (interaction.customId === 'ask_missing_info_bot2') {
        requestMessageText = '**เป็นงานของบริษัทอะไรครับ?**';
    } else if (interaction.customId === 'ask_company_bot2') {
        requestMessageText = '**งานนี้เป็นงานทำใหม่หรือแก้ไขครับ?**';
    } else if (interaction.customId === 'ask_type_duedate_bot2') {
        requestMessageText = '**กำหนดส่งวันไหนครับ?**';
    } else {
        return;
    }

    // แจ้งเตือนคนกดแบบเห็นคนเดียว (Ephemeral) ว่าส่งคำขอแล้ว
    await interaction.reply({ 
        content: '✅ ส่งข้อความแจ้งเตือนไปยังเจ้าของโพสต์เรียบร้อยแล้วครับ', 
        ephemeral: true 
    });

    // ส่งข้อความแท็กเรียกเจ้าของโพสต์ในเธรดสาธารณะ
    if (ownerId) {
        await interaction.channel.send({
            content: `📢 <@${ownerId}> ${requestMessageText}`
        });
    } else {
        await interaction.channel.send({
            content: `📢 **เจ้าของโพสต์ครับ**: ${requestMessageText}`
        });
    }

    // หมายเหตุ: เอาคำสั่งลบข้อความปุ่มออกแล้ว ปุ่มจะยังคงอยู่ให้กดได้ตลอดเวลาครับ
});

client.login(process.env.DISCORD_TOKEN);