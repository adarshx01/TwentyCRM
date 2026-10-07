import { definePageLayout, PageLayoutTabLayoutMode } from 'twenty-sdk/define';

import { FC_UNIVERSAL_IDENTIFIER, PAGE_UNIVERSAL_IDENTIFIER, TAB_UNIVERSAL_IDENTIFIER, WIDGET_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';

export default definePageLayout({
  universalIdentifier: PAGE_UNIVERSAL_IDENTIFIER,
  name: 'Bee',
  type: 'STANDALONE_PAGE',
  tabs: [
    {
      universalIdentifier: TAB_UNIVERSAL_IDENTIFIER,
      title: 'Bee',
      position: 0,
      icon: 'IconShieldCheck',
      layoutMode: PageLayoutTabLayoutMode.VERTICAL_LIST,
      widgets: [
        {
          universalIdentifier: WIDGET_UNIVERSAL_IDENTIFIER,
          title: 'Bee',
          type: 'FRONT_COMPONENT',
          heightBehavior: 'TAB_VIEWPORT',
          configuration: { configurationType: 'FRONT_COMPONENT', frontComponentUniversalIdentifier: FC_UNIVERSAL_IDENTIFIER },
        },
      ],
    },
  ],
});
