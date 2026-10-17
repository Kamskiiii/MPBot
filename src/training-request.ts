import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
} from 'discord.js';
import type { createApiClient } from './api.js';
import type { BotConfig } from './config.js';
import { inviteMembersByRoles } from './invite-thread-members.js';

export const TRAINING_REQUEST_BUTTON_ID = 'vp_training_request_btn';

const DEFAULT_TRAINING_TITLE = '🎓 Запрос обучения';
const DEFAULT_TRAINING_DESCRIPTION = [
  'Нажмите кнопку ниже, чтобы подать заявку на прохождение обучения в Военной Полиции.',
  '',
  '_Модерация проходит в приватных ветках._',
].join('\n');

type ApiClient = ReturnType<typeof createApiClient>;

function trainingEmbed(cfg: BotConfig): EmbedBuilder {
  const trainingCfg = cfg.training;
  const title = trainingCfg.panelTitle?.trim() || DEFAULT_TRAINING_TITLE;
  const description = trainingCfg.panelDescription?.trim() || DEFAULT_TRAINING_DESCRIPTION;

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(0x3498db);
}

function trainingComponents() {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(TRAINING_REQUEST_BUTTON_ID)
        .setLabel('Запросить обучение')
        .setStyle(ButtonStyle.Success),
    ),
  ];
}

/** Публикует или обновляет embed с кнопкой запроса обучения; сохраняет id сообщения в API. */
export async function syncTrainingPanel(
  client: Client,
  cfg: BotConfig,
  api: ApiClient,
): Promise<void> {
  const trainingCfg = cfg.training;
  const chId = trainingCfg.channelId;
  if (!chId) return;

  const botId = client.user?.id;
  if (!botId) return;

  const raw = await client.channels.fetch(chId).catch(() => null);
  if (!raw || raw.type !== ChannelType.GuildText) {
    console.warn(
      'training-panel: канал training.channelId должен быть обычным текстовым (#text)',
    );
    return;
  }

  if (cfg.guildId?.trim() && raw.guildId !== cfg.guildId.trim()) {
    console.warn('training-panel: канал не принадлежит указанному guildId');
    return;
  }

  const payload = {
    embeds: [trainingEmbed(cfg)],
    components: trainingComponents(),
  };

  const tryEdit = async (messageId: string): Promise<boolean> => {
    const msg = await raw.messages.fetch(messageId).catch(() => null);
    if (!msg || msg.author.id !== botId) return false;
    await msg.edit(payload);
    return true;
  };

  const storedId = trainingCfg.messageId?.trim();
  if (storedId && (await tryEdit(storedId))) {
    return;
  }

  const sent = await raw.send(payload);
  await api.setTrainingPanelMessageId(sent.id);
}

export async function handleTrainingRequestButton(
  interaction: ButtonInteraction,
  cfg: BotConfig,
): Promise<void> {
  if (interaction.customId !== TRAINING_REQUEST_BUTTON_ID) return;

  if (!interaction.guild || !interaction.channel) {
    await interaction.reply({ content: 'Ошибка контекста сервера.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const instructorRoleId = cfg.training.instructorRoleId ?? '';

  const member = interaction.member;
  const user = interaction.user;
  const userName = member && 'displayName' in member ? member.displayName : user.username;

  try {
    const channel = interaction.channel;
    if (!channel.isTextBased() || channel.isDMBased() || !('threads' in channel)) {
      await interaction.editReply({ content: 'Эту кнопку можно нажать только в текстовом канале сервера.' });
      return;
    }

    const threadName = `обучение-${userName}`.slice(0, 100);
    const thread = await (channel as any).threads.create({
      name: threadName,
      autoArchiveDuration: 1440,
      type: ChannelType.PrivateThread,
      reason: `Запрос обучения от ${userName}`,
    });

    // Добавляем заявителя в ветку
    await thread.members.add(user.id);

    // Автоматически приглашаем в приватную ветку всех участников с ролью инструктора
    if (instructorRoleId) {
      await inviteMembersByRoles(
        thread,
        interaction.guild,
        [instructorRoleId],
        new Set([user.id]),
      );
    }

    const instructorMention = instructorRoleId ? `<@&${instructorRoleId}>` : 'Инструкторы';

    const embed = new EmbedBuilder()
      .setTitle('🎓 Запрос на обучение')
      .setDescription(
        `Пользователь **${userName}** запросил проведение обучения.\n\n` +
          `Ответственные: ${instructorMention}\n` +
          `Пожалуйста, ожидайте ответа. В этой ветке можно обсудить детали и время.`
      )
      .setColor(0x3498db)
      .setTimestamp();

    await thread.send({
      content: `<@${user.id}> ${instructorRoleId ? `<@&${instructorRoleId}>` : ''}`,
      embeds: [embed],
    });

    await interaction.editReply({
      content: `Тикет по обучению успешно создан: <#${thread.id}>`,
    });
  } catch (e) {
    console.error('handleTrainingRequestButton error:', e);
    await interaction.editReply({
      content: 'Не удалось создать тикет обучения. Проверьте права бота (Manage Threads / Create Private Threads).',
    });
  }
}