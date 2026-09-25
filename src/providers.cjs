const providers = {
  github: { label: 'GitHub', hostname: 'github.com', keyUrl: 'https://github.com/settings/ssh/new', tokenUrl: 'https://github.com/settings/personal-access-tokens/new' },
  gitlab: { label: 'GitLab', hostname: 'gitlab.com', keyUrl: 'https://gitlab.com/-/user_settings/ssh_keys', tokenUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens' },
  bitbucket: { label: 'Bitbucket', hostname: 'bitbucket.org', keyUrl: 'https://bitbucket.org/account/settings/ssh-keys/', tokenUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens' }
};

const settingsPages = Object.values(providers).flatMap(p => [p.keyUrl, p.tokenUrl]);

module.exports = { providers, settingsPages };
