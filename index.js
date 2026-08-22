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
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
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
      invites: {},
    };
    sauvegarderConfig(config);
  }
  if (!config[guildId].invites) config[guildId].invites = {};
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

// Cache des invitations, pour savoir qui a invité qui (en mémoire)
const cacheInvitations = new Map(); // guildId -> Map(code -> uses)

async function rafraichirCacheInvitations(guild) {
  try {
    const invites = await guild.invites.fetch();
    cacheInvitations.set(guild.id, new Map(invites.map(inv => [inv.code, inv.uses])));
  } catch (e) {
    // Le bot n'a probablement pas la permission "Gérer le serveur"
    cacheInvitations.set(guild.id, new Map());
  }
}

// ============================================================
//  COMMANDES SLASH
// ============================================================

const commands = [
  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Ouvrir le panneau de configuration du bot (menus déroulants)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('config-bienvenue-banniere')
    .setDescription("Définir l'image de fond du message de bienvenue")
    .addAttachmentOption(o => o.setName('image').setDescription('Image à utiliser (laisser vide pour retirer la bannière)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('config-aurevoir-banniere')
    .setDescription("Définir l'image de fond du message d'au revoir")
    .addAttachmentOption(o => o.setName('image').setDescription('Image à utiliser (laisser vide pour retirer la bannière)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('ticket-panel')
    .setDescription('Envoyer le panneau pour ouvrir un ticket dans ce salon')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('ticket-fermer')
    .setDescription('Fermer le ticket en cours (à utiliser dans le salon du ticket)'),

  new SlashCommandBuilder()
    .setName('invitation')
    .setDescription('Savoir qui a invité un membre sur le serveur')
    .addUserOption(o => o.setName('membre').setDescription('Le membre à vérifier').setRequired(true)),
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

function construireMessageAccueil(conf, membre, { estBienvenue }) {
  const embed = new EmbedBuilder()
    .setDescription(remplacerVariables(conf.message, membre))
    .setColor(estBienvenue ? 0x57f287 : 0xed4245)
    .setThumbnail(membre.user.displayAvatarURL({ size: 256 }))
    .setFooter({ text: `${membre.guild.name} • ${membre.guild.memberCount} membre(s)`, iconURL: membre.guild.iconURL() || undefined })
    .setTimestamp();

  if (conf.bannerUrl) embed.setImage(conf.bannerUrl);

  // Le titre passe en contenu du message (en gros, via "# ") : c'est le seul
  // endroit où une mention {user} s'affiche vraiment comme un ping cliquable,
  // les mentions ne sont pas rendues dans le titre d'un embed.
  const contenu = `# ${remplacerVariables(conf.title, membre)}`;

  return { content: contenu, embeds: [embed] };
}

// ============================================================
//  PANNEAU /config (menus déroulants)
// ============================================================

const OPTIONS_MENU_PRINCIPAL = [
  { label: 'Bienvenue', value: 'bienvenue', emoji: '🎉', description: 'Salon, titre et texte de bienvenue' },
  { label: 'Au revoir', value: 'aurevoir', emoji: '👋', description: "Salon, titre et texte d'au revoir" },
  { label: 'Rôle automatique', value: 'autorole', emoji: '🎭', description: 'Rôle donné aux nouveaux membres' },
  { label: 'Anti-lien', value: 'antilien', emoji: '🔗', description: 'Suppression automatique des liens' },
  { label: 'Anti-raid', value: 'antiraid', emoji: '🛡️', description: "Protection contre les vagues d'arrivées" },
  { label: 'Tickets', value: 'tickets', emoji: '🎫', description: 'Catégorie, rôle staff et logs' },
];

function menuPrincipal() {
  const embed = new EmbedBuilder()
    .setTitle('⚙️ Panneau de configuration — Gestion')
    .setDescription('Choisis une catégorie dans le menu ci-dessous pour la configurer.')
    .setColor(0x2b6cb0);

  const select = new StringSelectMenuBuilder()
    .setCustomId('cfg_menu')
    .setPlaceholder('Choisir une catégorie...')
    .addOptions(OPTIONS_MENU_PRINCIPAL);

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
}

function boutonRetour() {
  return new ButtonBuilder().setCustomId('cfg_back').setLabel('Retour').setEmoji('⬅️').setStyle(ButtonStyle.Secondary);
}

function sectionBienvenue(gc) {
  const embed = new EmbedBuilder()
    .setTitle('🎉 Bienvenue')
    .setColor(0x57f287)
    .setDescription(
      `**Salon :** ${gc.welcome.channelId ? `<#${gc.welcome.channelId}>` : 'non défini'}\n` +
      `**Titre :** ${gc.welcome.title}\n**Texte :** ${gc.welcome.message}\n` +
      `**Bannière :** ${gc.welcome.bannerUrl ? 'définie ✅ (via /config-bienvenue-banniere)' : 'aucune (via /config-bienvenue-banniere)'}`
    );

  const selectSalon = new ChannelSelectMenuBuilder().setCustomId('cfg_welcome_channel').setPlaceholder('Choisir le salon de bienvenue').addChannelTypes(ChannelType.GuildText);
  const boutons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cfg_welcome_edit').setLabel('Modifier le texte').setEmoji('✏️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('cfg_welcome_test').setLabel('Tester').setEmoji('🧪').setStyle(ButtonStyle.Secondary),
    boutonRetour()
  );

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(selectSalon), boutons] };
}

function sectionAurevoir(gc) {
  const embed = new EmbedBuilder()
    .setTitle('👋 Au revoir')
    .setColor(0xed4245)
    .setDescription(
      `**Salon :** ${gc.goodbye.channelId ? `<#${gc.goodbye.channelId}>` : 'non défini'}\n` +
      `**Titre :** ${gc.goodbye.title}\n**Texte :** ${gc.goodbye.message}\n` +
      `**Bannière :** ${gc.goodbye.bannerUrl ? 'définie ✅ (via /config-aurevoir-banniere)' : 'aucune (via /config-aurevoir-banniere)'}`
    );

  const selectSalon = new ChannelSelectMenuBuilder().setCustomId('cfg_goodbye_channel').setPlaceholder("Choisir le salon d'au revoir").addChannelTypes(ChannelType.GuildText);
  const boutons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cfg_goodbye_edit').setLabel('Modifier le texte').setEmoji('✏️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('cfg_goodbye_test').setLabel('Tester').setEmoji('🧪').setStyle(ButtonStyle.Secondary),
    boutonRetour()
  );

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(selectSalon), boutons] };
}

function sectionAutorole(gc) {
  const embed = new EmbedBuilder()
    .setTitle('🎭 Rôle automatique')
    .setColor(0xfee75c)
    .setDescription(`**Rôle actuel :** ${gc.autoRole.roleId ? `<@&${gc.autoRole.roleId}>` : 'aucun'}`);

  const selectRole = new RoleSelectMenuBuilder().setCustomId('cfg_autorole_role').setPlaceholder('Choisir le rôle automatique');
  const boutons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cfg_autorole_clear').setLabel('Désactiver').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
    boutonRetour()
  );

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(selectRole), boutons] };
}

function sectionAntilien(gc) {
  const embed = new EmbedBuilder()
    .setTitle('🔗 Anti-lien')
    .setColor(0x5865f2)
    .setDescription(
      `**État :** ${gc.antiLink.enabled ? 'activé ✅' : 'désactivé ❌'}\n` +
      `**Salon de logs :** ${gc.antiLink.logChannelId ? `<#${gc.antiLink.logChannelId}>` : 'aucun'}`
    );

  const selectLogs = new ChannelSelectMenuBuilder().setCustomId('cfg_antilien_logs').setPlaceholder('Choisir le salon de logs').addChannelTypes(ChannelType.GuildText);
  const boutons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cfg_antilien_toggle').setLabel(gc.antiLink.enabled ? 'Désactiver' : 'Activer').setEmoji(gc.antiLink.enabled ? '🔴' : '🟢').setStyle(gc.antiLink.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    boutonRetour()
  );

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(selectLogs), boutons] };
}

function sectionAntiraid(gc) {
  const embed = new EmbedBuilder()
    .setTitle('🛡️ Anti-raid')
    .setColor(0x5865f2)
    .setDescription(
      `**État :** ${gc.antiRaid.enabled ? 'activé ✅' : 'désactivé ❌'}\n` +
      `**Seuil :** ${gc.antiRaid.joinThreshold} arrivées / ${gc.antiRaid.joinIntervalMs / 1000}s\n` +
      `**Action :** ${gc.antiRaid.action}\n` +
      `**Salon de logs :** ${gc.antiRaid.logChannelId ? `<#${gc.antiRaid.logChannelId}>` : 'aucun'}`
    );

  const selectAction = new StringSelectMenuBuilder().setCustomId('cfg_antiraid_action').setPlaceholder('Action sur les comptes suspects').addOptions(
    { label: 'Kick', value: 'kick', emoji: '👢' },
    { label: 'Ban', value: 'ban', emoji: '🔨' },
    { label: 'Alerte seulement', value: 'alert', emoji: '⚠️' }
  );
  const selectLogs = new ChannelSelectMenuBuilder().setCustomId('cfg_antiraid_logs').setPlaceholder('Choisir le salon de logs').addChannelTypes(ChannelType.GuildText);
  const boutons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cfg_antiraid_toggle').setLabel(gc.antiRaid.enabled ? 'Désactiver' : 'Activer').setEmoji(gc.antiRaid.enabled ? '🔴' : '🟢').setStyle(gc.antiRaid.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('cfg_antiraid_edit').setLabel('Régler seuil / intervalle').setEmoji('✏️').setStyle(ButtonStyle.Primary),
    boutonRetour()
  );

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(selectAction), new ActionRowBuilder().addComponents(selectLogs), boutons] };
}

function sectionTickets(gc) {
  const embed = new EmbedBuilder()
    .setTitle('🎫 Tickets')
    .setColor(0x2b6cb0)
    .setDescription(
      `**Catégorie :** ${gc.tickets.categoryId ? `<#${gc.tickets.categoryId}>` : 'non définie'}\n` +
      `**Rôle staff :** ${gc.tickets.staffRoleId ? `<@&${gc.tickets.staffRoleId}>` : 'non défini'}\n` +
      `**Salon de logs :** ${gc.tickets.logChannelId ? `<#${gc.tickets.logChannelId}>` : 'aucun'}\n\n` +
      `Une fois configuré, utilise \`/ticket-panel\` dans le salon où tu veux afficher le bouton "Ouvrir un ticket".`
    );

  const selectCategorie = new ChannelSelectMenuBuilder().setCustomId('cfg_tickets_categorie').setPlaceholder('Choisir la catégorie des tickets').addChannelTypes(ChannelType.GuildCategory);
  const selectRole = new RoleSelectMenuBuilder().setCustomId('cfg_tickets_role').setPlaceholder('Choisir le rôle staff');
  const selectLogs = new ChannelSelectMenuBuilder().setCustomId('cfg_tickets_logs').setPlaceholder('Choisir le salon de logs').addChannelTypes(ChannelType.GuildText);
  const boutons = new ActionRowBuilder().addComponents(boutonRetour());

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(selectCategorie), new ActionRowBuilder().addComponents(selectRole), new ActionRowBuilder().addComponents(selectLogs), boutons] };
}

function construireSection(section, gc) {
  switch (section) {
    case 'bienvenue': return sectionBienvenue(gc);
    case 'aurevoir': return sectionAurevoir(gc);
    case 'autorole': return sectionAutorole(gc);
    case 'antilien': return sectionAntilien(gc);
    case 'antiraid': return sectionAntiraid(gc);
    case 'tickets': return sectionTickets(gc);
    default: return menuPrincipal();
  }
}

function modaleTexte(customId, titreModale, valeurTitre, valeurMessage) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(titreModale);
  const champTitre = new TextInputBuilder().setCustomId('titre').setLabel('Titre (variables : {user} {server} {count})').setStyle(TextInputStyle.Short).setValue(valeurTitre).setRequired(true).setMaxLength(256);
  const champMessage = new TextInputBuilder().setCustomId('message').setLabel('Texte (variables : {user} {server} {count})').setStyle(TextInputStyle.Paragraph).setValue(valeurMessage).setRequired(true).setMaxLength(1000);
  modal.addComponents(new ActionRowBuilder().addComponents(champTitre), new ActionRowBuilder().addComponents(champMessage));
  return modal;
}

function modaleAntiraid(gc) {
  const modal = new ModalBuilder().setCustomId('cfg_antiraid_modal').setTitle('Réglages anti-raid');
  const champSeuil = new TextInputBuilder().setCustomId('seuil').setLabel("Nombre d'arrivées suspectes").setStyle(TextInputStyle.Short).setValue(String(gc.antiRaid.joinThreshold)).setRequired(true).setMaxLength(3);
  const champIntervalle = new TextInputBuilder().setCustomId('intervalle').setLabel('Intervalle en secondes').setStyle(TextInputStyle.Short).setValue(String(gc.antiRaid.joinIntervalMs / 1000)).setRequired(true).setMaxLength(4);
  modal.addComponents(new ActionRowBuilder().addComponents(champSeuil), new ActionRowBuilder().addComponents(champIntervalle));
  return modal;
}

// ============================================================
//  ÉVÉNEMENT : PRÊT
// ============================================================

client.once(Events.ClientReady, async () => {
  console.log(`Connecté en tant que ${client.user.tag}`);
  await enregistrerCommandes();
  for (const guild of client.guilds.cache.values()) {
    await rafraichirCacheInvitations(guild);
  }
});

// Le bot rejoint un nouveau serveur -> initialiser son cache d'invitations
client.on(Events.GuildCreate, (guild) => rafraichirCacheInvitations(guild));

// Une invitation est créée/supprimée -> garder le cache à jour
client.on(Events.InviteCreate, (invite) => {
  const c = cacheInvitations.get(invite.guild.id) || new Map();
  c.set(invite.code, invite.uses);
  cacheInvitations.set(invite.guild.id, c);
});
client.on(Events.InviteDelete, (invite) => {
  cacheInvitations.get(invite.guild.id)?.delete(invite.code);
});

// ============================================================
//  ÉVÉNEMENT : ARRIVÉE D'UN MEMBRE (bienvenue + rôle auto + anti-raid)
// ============================================================

client.on(Events.GuildMemberAdd, async (membre) => {
  const gc = getGuildConfig(membre.guild.id);

  // Suivi des invitations : on compare le nombre d'utilisations avant/après l'arrivée
  try {
    const nouvellesInvites = await membre.guild.invites.fetch();
    const anciennesInvites = cacheInvitations.get(membre.guild.id) || new Map();
    const inviteUtilisee = nouvellesInvites.find(inv => (anciennesInvites.get(inv.code) || 0) < inv.uses);
    cacheInvitations.set(membre.guild.id, new Map(nouvellesInvites.map(inv => [inv.code, inv.uses])));

    if (inviteUtilisee) {
      gc.invites[membre.id] = {
        inviterId: inviteUtilisee.inviter ? inviteUtilisee.inviter.id : null,
        inviterTag: inviteUtilisee.inviter ? inviteUtilisee.inviter.tag : 'Inconnu',
        code: inviteUtilisee.code,
        date: Date.now(),
      };
    } else {
      gc.invites[membre.id] = { inviterId: null, inviterTag: null, code: null, date: Date.now() };
    }
    sauvegarderConfig(config);
  } catch (e) {
    // Pas de permission "Gérer le serveur" -> on ignore, la commande /invitation le signalera
  }

  // Message de bienvenue
  if (gc.welcome.channelId) {
    const salon = membre.guild.channels.cache.get(gc.welcome.channelId);
    if (salon) salon.send(construireMessageAccueil(gc.welcome, membre, { estBienvenue: true })).catch(() => {});
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
    if (salon) salon.send(construireMessageAccueil(gc.goodbye, membre, { estBienvenue: false })).catch(() => {});
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
    } else if (interaction.isStringSelectMenu()) {
      await gererSelectMenu(interaction);
    } else if (interaction.isChannelSelectMenu() || interaction.isRoleSelectMenu()) {
      await gererSelectMenu(interaction);
    } else if (interaction.isModalSubmit()) {
      await gererModale(interaction);
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
    case 'config': {
      await interaction.reply({ ...menuPrincipal(), ephemeral: true });
      break;
    }
    case 'config-bienvenue-banniere': {
      const image = interaction.options.getAttachment('image');
      gc.welcome.bannerUrl = image ? image.url : null;
      sauvegarderConfig(config);
      await interaction.reply({ content: image ? '✅ Bannière de bienvenue mise à jour.' : '✅ Bannière de bienvenue retirée.', ephemeral: true });
      break;
    }
    case 'config-aurevoir-banniere': {
      const image = interaction.options.getAttachment('image');
      gc.goodbye.bannerUrl = image ? image.url : null;
      sauvegarderConfig(config);
      await interaction.reply({ content: image ? "✅ Bannière d'au revoir mise à jour." : "✅ Bannière d'au revoir retirée.", ephemeral: true });
      break;
    }
    case 'ticket-panel': {
      if (!gc.tickets.categoryId || !gc.tickets.staffRoleId) {
        await interaction.reply({ content: "⚠️ Configure d'abord la catégorie et le rôle staff via `/config` → 🎫 Tickets.", ephemeral: true });
        return;
      }
      gc.tickets.enabled = true;
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
    case 'invitation': {
      const cible = interaction.options.getUser('membre');
      const info = gc.invites[cible.id];

      if (!info) {
        await interaction.reply({ content: `⚠️ Aucune invitation enregistrée pour ${cible} (probablement présent sur le serveur avant l'installation du bot, ou le bot n'a pas la permission "Gérer le serveur").`, ephemeral: true });
        return;
      }
      if (!info.inviterId) {
        await interaction.reply({ content: `ℹ️ ${cible} a rejoint via un lien d'invitation dont l'auteur n'a pas pu être identifié (lien vanity, widget, ou invitation expirée).`, ephemeral: true });
        return;
      }
      await interaction.reply({ content: `👥 ${cible} a été invité par <@${info.inviterId}> (\`${info.inviterTag}\`) via le code \`${info.code}\`.`, ephemeral: true });
      break;
    }
  }
}

// ---- Menu principal + navigation entre sections ----

async function gererSelectMenu(interaction) {
  const gc = getGuildConfig(interaction.guild.id);
  const id = interaction.customId;

  if (id === 'cfg_menu') {
    await interaction.update(construireSection(interaction.values[0], gc));
    return;
  }
  if (id === 'cfg_welcome_channel') {
    gc.welcome.channelId = interaction.values[0];
    sauvegarderConfig(config);
    await interaction.update(sectionBienvenue(gc));
    return;
  }
  if (id === 'cfg_goodbye_channel') {
    gc.goodbye.channelId = interaction.values[0];
    sauvegarderConfig(config);
    await interaction.update(sectionAurevoir(gc));
    return;
  }
  if (id === 'cfg_autorole_role') {
    gc.autoRole.roleId = interaction.values[0];
    sauvegarderConfig(config);
    await interaction.update(sectionAutorole(gc));
    return;
  }
  if (id === 'cfg_antilien_logs') {
    gc.antiLink.logChannelId = interaction.values[0];
    sauvegarderConfig(config);
    await interaction.update(sectionAntilien(gc));
    return;
  }
  if (id === 'cfg_antiraid_action') {
    gc.antiRaid.action = interaction.values[0];
    sauvegarderConfig(config);
    await interaction.update(sectionAntiraid(gc));
    return;
  }
  if (id === 'cfg_antiraid_logs') {
    gc.antiRaid.logChannelId = interaction.values[0];
    sauvegarderConfig(config);
    await interaction.update(sectionAntiraid(gc));
    return;
  }
  if (id === 'cfg_tickets_categorie') {
    gc.tickets.categoryId = interaction.values[0];
    sauvegarderConfig(config);
    await interaction.update(sectionTickets(gc));
    return;
  }
  if (id === 'cfg_tickets_role') {
    gc.tickets.staffRoleId = interaction.values[0];
    sauvegarderConfig(config);
    await interaction.update(sectionTickets(gc));
    return;
  }
  if (id === 'cfg_tickets_logs') {
    gc.tickets.logChannelId = interaction.values[0];
    sauvegarderConfig(config);
    await interaction.update(sectionTickets(gc));
    return;
  }
}

async function gererModale(interaction) {
  const gc = getGuildConfig(interaction.guild.id);

  if (interaction.customId === 'cfg_welcome_modal') {
    gc.welcome.title = interaction.fields.getTextInputValue('titre');
    gc.welcome.message = interaction.fields.getTextInputValue('message');
    sauvegarderConfig(config);
    await interaction.update(sectionBienvenue(gc));
    return;
  }
  if (interaction.customId === 'cfg_goodbye_modal') {
    gc.goodbye.title = interaction.fields.getTextInputValue('titre');
    gc.goodbye.message = interaction.fields.getTextInputValue('message');
    sauvegarderConfig(config);
    await interaction.update(sectionAurevoir(gc));
    return;
  }
  if (interaction.customId === 'cfg_antiraid_modal') {
    const seuil = parseInt(interaction.fields.getTextInputValue('seuil'), 10);
    const intervalle = parseInt(interaction.fields.getTextInputValue('intervalle'), 10);
    if (!Number.isNaN(seuil) && seuil > 0) gc.antiRaid.joinThreshold = seuil;
    if (!Number.isNaN(intervalle) && intervalle > 0) gc.antiRaid.joinIntervalMs = intervalle * 1000;
    sauvegarderConfig(config);
    await interaction.update(sectionAntiraid(gc));
    return;
  }
}

async function gererBouton(interaction) {
  const gc = getGuildConfig(interaction.guild.id);

  // ---- Boutons du panneau /config ----
  if (interaction.customId === 'cfg_back') {
    await interaction.update(menuPrincipal());
    return;
  }
  if (interaction.customId === 'cfg_welcome_edit') {
    await interaction.showModal(modaleTexte('cfg_welcome_modal', 'Texte de bienvenue', gc.welcome.title, gc.welcome.message));
    return;
  }
  if (interaction.customId === 'cfg_goodbye_edit') {
    await interaction.showModal(modaleTexte('cfg_goodbye_modal', "Texte d'au revoir", gc.goodbye.title, gc.goodbye.message));
    return;
  }
  if (interaction.customId === 'cfg_welcome_test') {
    const apercu = construireMessageAccueil(gc.welcome, interaction.member, { estBienvenue: true });
    await interaction.reply({ content: `**Aperçu (visible uniquement par toi) :**\n${apercu.content}`, embeds: apercu.embeds, ephemeral: true });
    return;
  }
  if (interaction.customId === 'cfg_goodbye_test') {
    const apercu = construireMessageAccueil(gc.goodbye, interaction.member, { estBienvenue: false });
    await interaction.reply({ content: `**Aperçu (visible uniquement par toi) :**\n${apercu.content}`, embeds: apercu.embeds, ephemeral: true });
    return;
  }
  if (interaction.customId === 'cfg_autorole_clear') {
    gc.autoRole.roleId = null;
    sauvegarderConfig(config);
    await interaction.update(sectionAutorole(gc));
    return;
  }
  if (interaction.customId === 'cfg_antilien_toggle') {
    gc.antiLink.enabled = !gc.antiLink.enabled;
    sauvegarderConfig(config);
    await interaction.update(sectionAntilien(gc));
    return;
  }
  if (interaction.customId === 'cfg_antiraid_toggle') {
    gc.antiRaid.enabled = !gc.antiRaid.enabled;
    sauvegarderConfig(config);
    await interaction.update(sectionAntiraid(gc));
    return;
  }
  if (interaction.customId === 'cfg_antiraid_edit') {
    await interaction.showModal(modaleAntiraid(gc));
    return;
  }

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
