import { defineNavigationMenuItem, NavigationMenuItemType } from 'twenty-sdk/define';

import { NAV_UNIVERSAL_IDENTIFIER, PAGE_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';

export default defineNavigationMenuItem({
  universalIdentifier: NAV_UNIVERSAL_IDENTIFIER,
  name: 'Bee',
  icon: 'IconShieldCheck',
  color: 'yellow',
  position: 1,
  type: NavigationMenuItemType.PAGE_LAYOUT,
  pageLayoutUniversalIdentifier: PAGE_UNIVERSAL_IDENTIFIER,
});
