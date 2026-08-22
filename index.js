/**
 * ============================================================
 *  BOT "GESTION"
 *  Système de tickets, bienvenue/au revoir, rôle automatique,
 *  anti-lien, anti-raid.
 *  Architecture mono-fichier (déploiement GitHub -> Railway).
 * ============================================================
 *
 *  Variables d'environnement à définir sur Railway :
 *    TOKEN     -> token du bot Discord
 *    CLIENT_ID -> ID de l'application Discord
 *
 *  Commande pour lancer le bot : node index.js
 * ============================================================
 */

const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  RoleSelectMenuBuilder,
  ChannelSelectMenuBuilder,
} = require('discord.js');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const CONFIG_PATH = path.join(__dirname, 'config.json');

// ============================================================
//  PERSISTANCE (config.json, un objet par serveur)
// ============================================================

function chargerConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({}, null, 2));
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error('Erreur de lecture de config.json, réinitialisation.', e);
    return {};
  }
}

function sauvegarderConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

let config = chargerConfig();

function getGuildConfig(guildId) {
  if (!config[guildId]) {
    config[guildId] = {
      welcome: {
        channelId: null,
        title: 'Bienvenue {user} !',
        message: "Un nouveau membre rejoint **{server}** !\n\nNous sommes ravis de t'avoir parmi nous.",
        bannerUrl: null,
      },
      goodbye: {
        channelId: null,
        title: 'Départ de {user}...',
        message: '{user} a quitté **{server}**.\n\nNous sommes maintenant {count} membre(s).',
        bannerUrl: null,
      },
      autoRole: { roleId: null },
      antiLink: { enabled: false, logChannelId: null, whitelistRoleIds: [], whitelistChannelIds: [] },
      antiRaid: { enabled: false, joinThreshold: 5, joinIntervalMs: 10000, action: 'kick', logChannelId: null },
      tickets: { enabled: false, categoryId: null, staffRoleId: null, logChannelId: null, panelChannelId: null, counter: 0, openTickets: {} },
    };
    sauvegarderConfig(config);
  }
  return config[guildId];
}

// ============================================================
//  CLIENT DISCORD
// ============================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildInvites,
  ],
  partials: [Partials.Channel, Partials.GuildMember],
});

// Historique des arrivées récentes, pour l'anti-raid (en mémoire)
const joinsRecents = new Map(); // guildId -> [timestamps]

// ============================================================
//  COMMANDES SLASH
// ============================================================

const commands = [
  new SlashCommandBuilder()
    .setName('config-bienvenue')
    .setDescription("Configurer le message de bienvenue (un texte par défaut est déjà en place)")
    .addChannelOption(o => o.setName('salon').setDescription('Salon des messages de bienvenue').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addStringOption(o => o.setName('titre').setDescription('Titre (variables : {user} {server} {count})').setRequired(false))
    .addStringOption(o => o.setName('message').setDescription('Texte (variables : {user} {server} {count})').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('config-bienvenue-banniere')
    .setDescription("Définir l'image de fond du message de bienvenue")
    .addAttachmentOption(o => o.setName('image').setDescription('Image à utiliser (laisser vide pour retirer la bannière)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('config-aurevoir')
    .setDescription("Configurer le message d'au revoir (un texte par défaut est déjà en place)")
    .addChannelOption(o => o.setName('salon').setDescription("Salon des messages d'au revoir").addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addStringOption(o => o.setName('titre').setDescription('Titre (variables : {user} {server} {count})').setRequired(false))
    .addStringOption(o => o.setName('message').setDescription('Texte (variables : {user} {server} {count})').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('config-aurevoir-banniere')
    .setDescription("Définir l'image de fond du message d'au revoir")
    .addAttachmentOption(o => o.setName('image').setDescription('Image à utiliser (laisser vide pour retirer la bannière)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('config-autorole')
    .setDescription("Définir le rôle automatique donné aux nouveaux membres")
    .addRoleOption(o => o.setName('role').setDescription('Rôle à attribuer (laisser vide pour désactiver)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('config-antilien')
    .setDescription('Activer/configurer la protection anti-lien')
    .addStringOption(o => o.setName('etat').setDescription('on ou off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }))
    .addChannelOption(o => o.setName('salon-logs').setDescription('Salon de logs (optionnel)').addChannelTypes(ChannelType.GuildText).setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('config-antiraid')
    .setDescription('Activer/configurer la protection anti-raid')
    .addStringOption(o => o.setName('etat').setDescription('on ou off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }))
    .addIntegerOption(o => o.setName('seuil').setDescription("Nombre d'arrivées suspectes (défaut 5)").setRequired(false))
    .addIntegerOption(o => o.setName('intervalle-secondes').setDescription('Intervalle en secondes (défaut 10)').setRequired(false))
    .addStringOption(o => o.setName('action').setDescription('Action sur les comptes suspects').addChoices({ name: 'kick', value: 'kick' }, { name: 'ban', value: 'ban' }, { name: 'alerte seulement', value: 'alert' }).setRequired(false))
    .addChannelOption(o => o.setName('salon-logs').setDescription('Salon de logs (optionnel)').addChannelTypes(ChannelType.GuildText).setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('config-tickets')
    .setDescription('Configurer le système de tickets')
    .addChannelOption(o => o.setName('categorie').setDescription('Catégorie où créer les tickets').addChannelTypes(ChannelType.GuildCategory).setRequired(true))
    .addRoleOption(o => o.setName('role-staff').setDescription("Rôle du staff qui voit les tickets").setRequired(true))
    .addChannelOption(o => o.setName('salon-logs').setDescription('Salon de logs (optionnel)').addChannelTypes(ChannelType.GuildText).setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('ticket-panel')
    .setDescription('Envoyer le panneau pour ouvrir un ticket dans ce salon')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('ticket-fermer')
    .setDescription('Fermer le ticket en cours (à utiliser dans le salon du ticket)'),
].map(c => c.toJSON());

async function enregistrerCommandes() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log(`${commands.length} commandes slash enregistrées.`);
}

// ============================================================
//  UTILITAIRES
// ============================================================

function remplacerVariables(texte, membre) {
  return texte
    .replaceAll('{user}', `<@${membre.id}>`)
    .replaceAll('{server}', membre.guild.name)
    .replaceAll('{count}', membre.guild.memberCount);
}

const REGEX_LIEN = /(https?:\/\/|www\.)[^\s]+/gi;

function construireEmbedAccueil(conf, membre, { estBienvenue }) {
  const embed = new EmbedBuilder()
    .setTitle(remplacerVariables(conf.title, membre))
    .setDescription(remplacerVariables(conf.message, membre))
    .setColor(estBienvenue ? 0x57f287 : 0xed4245)
    .setThumbnail(membre.user.displayAvatarURL({ size: 256 }))
    .setFooter({ text: `${membre.guild.name} • ${membre.guild.memberCount} membre(s)`, iconURL: membre.guild.iconURL() || undefined })
    .setTimestamp();

  if (conf.bannerUrl) embed.setImage(conf.bannerUrl);

  return embed;
}

// ============================================================
//  ÉVÉNEMENT : PRÊT
// ============================================================

client.once(Events.ClientReady, async () => {
  console.log(`Connecté en tant que ${client.user.tag}`);
  await enregistrerCommandes();
});

// ============================================================
//  ÉVÉNEMENT : ARRIVÉE D'UN MEMBRE (bienvenue + rôle auto + anti-raid)
// ============================================================

client.on(Events.GuildMemberAdd, async (membre) => {
  const gc = getGuildConfig(membre.guild.id);

  // Message de bienvenue
  if (gc.welcome.channelId) {
    const salon = membre.guild.channels.cache.get(gc.welcome.channelId);
    if (salon) {
      const embed = construireEmbedAccueil(gc.welcome, membre, { estBienvenue: true });
      salon.send({ content: `${membre}`, embeds: [embed] }).catch(() => {});
    }
  }

  // Rôle automatique
  if (gc.autoRole.roleId) {
    const role = membre.guild.roles.cache.get(gc.autoRole.roleId);
    if (role) membre.roles.add(role).catch(() => {});
  }

  // Anti-raid : on suit les arrivées récentes
  if (gc.antiRaid.enabled) {
    const now = Date.now();
    const liste = (joinsRecents.get(membre.guild.id) || []).filter(t => now - t < gc.antiRaid.joinIntervalMs);
    liste.push(now);
    joinsRecents.set(membre.guild.id, liste);

    if (liste.length >= gc.antiRaid.joinThreshold) {
      const logSalon = gc.antiRaid.logChannelId ? membre.guild.channels.cache.get(gc.antiRaid.logChannelId) : null;

      if (gc.antiRaid.action === 'kick' && membre.kickable) {
        await membre.kick('Anti-raid : vague de connexions suspecte').catch(() => {});
      } else if (gc.antiRaid.action === 'ban' && membre.bannable) {
        await membre.ban({ reason: 'Anti-raid : vague de connexions suspecte' }).catch(() => {});
      }

      if (logSalon) {
        logSalon.send(`🚨 **Anti-raid déclenché** : ${liste.length} arrivées en moins de ${gc.antiRaid.joinIntervalMs / 1000}s. Dernier membre : ${membre.user.tag} (action : ${gc.antiRaid.action}).`).catch(() => {});
      }
    }
  }
});

// ============================================================
//  ÉVÉNEMENT : DÉPART D'UN MEMBRE (au revoir)
// ============================================================

client.on(Events.GuildMemberRemove, async (membre) => {
  const gc = getGuildConfig(membre.guild.id);
  if (gc.goodbye.channelId) {
    const salon = membre.guild.channels.cache.get(gc.goodbye.channelId);
    if (salon) {
      const embed = construireEmbedAccueil(gc.goodbye, membre, { estBienvenue: false });
      salon.send({ embeds: [embed] }).catch(() => {});
    }
  }
});

// ============================================================
//  ÉVÉNEMENT : MESSAGES (anti-lien)
// ============================================================

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  const gc = getGuildConfig(message.guild.id);
  if (!gc.antiLink.enabled) return;

  const membre = message.member;
  const estWhitelist =
    (membre && membre.permissions.has(PermissionFlagsBits.ManageGuild)) ||
    gc.antiLink.whitelistRoleIds.some(id => membre?.roles.cache.has(id)) ||
    gc.antiLink.whitelistChannelIds.includes(message.channel.id);

  if (estWhitelist) return;

  if (REGEX_LIEN.test(message.content)) {
    await message.delete().catch(() => {});
    const avertissement = await message.channel.send(`${message.author}, les liens ne sont pas autorisés ici.`).catch(() => {});
    if (avertissement) setTimeout(() => avertissement.delete().catch(() => {}), 5000);

    if (gc.antiLink.logChannelId) {
      const logSalon = message.guild.channels.cache.get(gc.antiLink.logChannelId);
      if (logSalon) logSalon.send(`🔗 Lien supprimé de ${message.author.tag} dans ${message.channel} : \`${message.content.slice(0, 200)}\``).catch(() => {});
    }
  }
});

// ============================================================
//  ÉVÉNEMENT : INTERACTIONS (slash commands + boutons)
// ============================================================

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await gererCommande(interaction);
    } else if (interaction.isButton()) {
      await gererBouton(interaction);
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      const payload = { content: "Une erreur est survenue.", ephemeral: true };
      interaction.deferred || interaction.replied ? interaction.followUp(payload).catch(() => {}) : interaction.reply(payload).catch(() => {});
    }
  }
});

async function gererCommande(interaction) {
  const gc = getGuildConfig(interaction.guild.id);

  switch (interaction.commandName) {
    case 'config-bienvenue': {
      gc.welcome.channelId = interaction.options.getChannel('salon').id;
      const titre = interaction.options.getString('titre');
      const msg = interaction.options.getString('message');
      if (titre) gc.welcome.title = titre;
      if (msg) gc.welcome.message = msg;
      sauvegarderConfig(config);
      const apercu = construireEmbedAccueil(gc.welcome, interaction.member, { estBienvenue: true });
      await interaction.reply({ content: `✅ Message de bienvenue configuré dans <#${gc.welcome.channelId}>. Aperçu :`, embeds: [apercu], ephemeral: true });
      break;
    }
    case 'config-bienvenue-banniere': {
      const image = interaction.options.getAttachment('image');
      gc.welcome.bannerUrl = image ? image.url : null;
      sauvegarderConfig(config);
      await interaction.reply({ content: image ? '✅ Bannière de bienvenue mise à jour.' : '✅ Bannière de bienvenue retirée.', ephemeral: true });
      break;
    }
    case 'config-aurevoir': {
      gc.goodbye.channelId = interaction.options.getChannel('salon').id;
      const titre = interaction.options.getString('titre');
      const msg = interaction.options.getString('message');
      if (titre) gc.goodbye.title = titre;
      if (msg) gc.goodbye.message = msg;
      sauvegarderConfig(config);
      const apercu = construireEmbedAccueil(gc.goodbye, interaction.member, { estBienvenue: false });
      await interaction.reply({ content: `✅ Message d'au revoir configuré dans <#${gc.goodbye.channelId}>. Aperçu :`, embeds: [apercu], ephemeral: true });
      break;
    }
    case 'config-aurevoir-banniere': {
      const image = interaction.options.getAttachment('image');
      gc.goodbye.bannerUrl = image ? image.url : null;
      sauvegarderConfig(config);
      await interaction.reply({ content: image ? "✅ Bannière d'au revoir mise à jour." : "✅ Bannière d'au revoir retirée.", ephemeral: true });
      break;
    }
    case 'config-autorole': {
      const role = interaction.options.getRole('role');
      gc.autoRole.roleId = role ? role.id : null;
      sauvegarderConfig(config);
      await interaction.reply({ content: role ? `✅ Rôle automatique : ${role}.` : '✅ Rôle automatique désactivé.', ephemeral: true });
      break;
    }
    case 'config-antilien': {
      gc.antiLink.enabled = interaction.options.getString('etat') === 'on';
      const logSalon = interaction.options.getChannel('salon-logs');
      if (logSalon) gc.antiLink.logChannelId = logSalon.id;
      sauvegarderConfig(config);
      await interaction.reply({ content: `✅ Anti-lien ${gc.antiLink.enabled ? 'activé' : 'désactivé'}.`, ephemeral: true });
      break;
    }
    case 'config-antiraid': {
      gc.antiRaid.enabled = interaction.options.getString('etat') === 'on';
      const seuil = interaction.options.getInteger('seuil');
      const intervalle = interaction.options.getInteger('intervalle-secondes');
      const action = interaction.options.getString('action');
      const logSalon = interaction.options.getChannel('salon-logs');
      if (seuil) gc.antiRaid.joinThreshold = seuil;
      if (intervalle) gc.antiRaid.joinIntervalMs = intervalle * 1000;
      if (action) gc.antiRaid.action = action;
      if (logSalon) gc.antiRaid.logChannelId = logSalon.id;
      sauvegarderConfig(config);
      await interaction.reply({ content: `✅ Anti-raid ${gc.antiRaid.enabled ? 'activé' : 'désactivé'} (seuil : ${gc.antiRaid.joinThreshold} arrivées / ${gc.antiRaid.joinIntervalMs / 1000}s, action : ${gc.antiRaid.action}).`, ephemeral: true });
      break;
    }
    case 'config-tickets': {
      gc.tickets.enabled = true;
      gc.tickets.categoryId = interaction.options.getChannel('categorie').id;
      gc.tickets.staffRoleId = interaction.options.getRole('role-staff').id;
      const logSalon = interaction.options.getChannel('salon-logs');
      if (logSalon) gc.tickets.logChannelId = logSalon.id;
      sauvegarderConfig(config);
      await interaction.reply({ content: '✅ Système de tickets configuré. Utilise `/ticket-panel` dans le salon de ton choix pour afficher le bouton.', ephemeral: true });
      break;
    }
    case 'ticket-panel': {
      if (!gc.tickets.enabled) {
        await interaction.reply({ content: "⚠️ Configure d'abord les tickets avec `/config-tickets`.", ephemeral: true });
        return;
      }
      const embed = new EmbedBuilder()
        .setTitle('🎫 Support')
        .setDescription('Clique sur le bouton ci-dessous pour ouvrir un ticket avec le staff.')
        .setColor(0x2b6cb0);
      const bouton = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ouvrir_ticket').setLabel('Ouvrir un ticket').setEmoji('🎫').setStyle(ButtonStyle.Primary)
      );
      gc.tickets.panelChannelId = interaction.channel.id;
      sauvegarderConfig(config);
      await interaction.channel.send({ embeds: [embed], components: [bouton] });
      await interaction.reply({ content: '✅ Panneau envoyé.', ephemeral: true });
      break;
    }
    case 'ticket-fermer': {
      await fermerTicket(interaction);
      break;
    }
  }
}

async function gererBouton(interaction) {
  const gc = getGuildConfig(interaction.guild.id);

  if (interaction.customId === 'ouvrir_ticket') {
    if (!gc.tickets.enabled) {
      await interaction.reply({ content: '⚠️ Système de tickets non configuré.', ephemeral: true });
      return;
    }

    // Empêcher un membre d'ouvrir plusieurs tickets
    const ticketExistantId = gc.tickets.openTickets[interaction.user.id];
    if (ticketExistantId && interaction.guild.channels.cache.has(ticketExistantId)) {
      await interaction.reply({ content: `⚠️ Tu as déjà un ticket ouvert : <#${ticketExistantId}>.`, ephemeral: true });
      return;
    }

    gc.tickets.counter += 1;
    const nomSalon = `ticket-${gc.tickets.counter}`;

    const salonTicket = await interaction.guild.channels.create({
      name: nomSalon,
      type: ChannelType.GuildText,
      parent: gc.tickets.categoryId,
      permissionOverwrites: [
        { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: gc.tickets.staffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      ],
    });

    gc.tickets.openTickets[interaction.user.id] = salonTicket.id;
    sauvegarderConfig(config);

    const embed = new EmbedBuilder()
      .setTitle(`Ticket #${gc.tickets.counter}`)
      .setDescription(`Bonjour ${interaction.user}, le staff (<@&${gc.tickets.staffRoleId}>) va te répondre. Utilise le bouton ci-dessous ou \`/ticket-fermer\` pour clore ce ticket.`)
      .setColor(0x2b6cb0);
    const boutonFermer = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('fermer_ticket').setLabel('Fermer le ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger)
    );

    await salonTicket.send({ content: `${interaction.user} <@&${gc.tickets.staffRoleId}>`, embeds: [embed], components: [boutonFermer] });
    await interaction.reply({ content: `✅ Ticket créé : ${salonTicket}`, ephemeral: true });

    if (gc.tickets.logChannelId) {
      const logSalon = interaction.guild.channels.cache.get(gc.tickets.logChannelId);
      if (logSalon) logSalon.send(`🎫 Ticket ouvert par ${interaction.user.tag} : ${salonTicket}`).catch(() => {});
    }
  }

  if (interaction.customId === 'fermer_ticket') {
    await fermerTicket(interaction);
  }
}

async function fermerTicket(interaction) {
  const gc = getGuildConfig(interaction.guild.id);
  const salon = interaction.channel;

  const proprietaireId = Object.keys(gc.tickets.openTickets).find(uid => gc.tickets.openTickets[uid] === salon.id);
  if (!proprietaireId) {
    await interaction.reply({ content: "⚠️ Ce salon n'est pas un ticket ouvert.", ephemeral: true });
    return;
  }

  await interaction.reply({ content: '🔒 Fermeture du ticket dans 5 secondes...' });

  if (gc.tickets.logChannelId) {
    const logSalon = interaction.guild.channels.cache.get(gc.tickets.logChannelId);
    if (logSalon) logSalon.send(`🔒 Ticket fermé par ${interaction.user.tag} : ${salon.name}`).catch(() => {});
  }

  delete gc.tickets.openTickets[proprietaireId];
  sauvegarderConfig(config);

  setTimeout(() => salon.delete().catch(() => {}), 5000);
}

// ============================================================
//  DÉMARRAGE
// ============================================================

if (!TOKEN || !CLIENT_ID) {
  console.error('⚠️ Il manque TOKEN et/ou CLIENT_ID dans les variables d\'environnement.');
  process.exit(1);
}

client.login(TOKEN);
