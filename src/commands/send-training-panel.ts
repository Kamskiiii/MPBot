import { 
  SlashCommandBuilder, 
  PermissionFlagsBits, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  type ChatInputCommandInteraction 
} from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('setup-training')
  .setDescription('Отправляет панель запроса обучения в текущий канал')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator); // Только для админов

export async function execute(interaction: ChatInputCommandInteraction) {
  const channel = interaction.channel;

  if (!channel) {
    await interaction.reply({ content: 'Не удалось определить канал.', flags: 64 });
    return;
  }

  // Создаём красивый Embed
  const embed = new EmbedBuilder()
    .setTitle('🏆 Запрос обучения')
    .setDescription('Нажмите на кнопку ниже, чтобы подать заявку на прохождение обучения в Военной Полиции.')
    .setColor(0x3498db);

  // Создаём кнопку (убедитесь, что customId совпадает с тем, что ждет training-request.ts)
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('request_training') 
      .setLabel('Запросить обучение')
      .setStyle(ButtonStyle.Success)
  );

  // Отправляем сообщение в канал
  await channel.send({ embeds: [embed], components: [row] });

  // Уведомляем администратора скрытым ответом
  await interaction.reply({ content: 'Панель успешно отправлена в этот канал!', flags: 64 });
}