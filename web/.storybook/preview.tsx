import '@fontsource/manrope/latin-400.css'
import '@fontsource/manrope/latin-600.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '../src/theme.css'

import type { Decorator, Preview } from '@storybook/react-vite'
import { COLOUR_THEMES, DEFAULT_COLOUR_THEME, applyColourTheme } from '../src/lib/colourTheme'
import { BILLING, DOCS, INFRA, MESSAGES, MOBILE, MODELS, QUIET, SETTINGS, TAGS } from '../../site/demo/fake/fixtures'
import { installFakeServer } from '../../site/demo/fake/install'

/**
 * The website's demo world (`site/demo/fake`): `/api` and the socket answered
 * in the page, from made-up projects and sessions. A story of a panel that
 * reads the store or calls the API gets the same answers the demos get, and
 * no story can reach a real Orbital.
 */
installFakeServer({
  sessions: [BILLING, DOCS, MOBILE, INFRA, ...QUIET],
  tags: TAGS,
  models: MODELS,
  settings: SETTINGS,
  messages: MESSAGES,
})

/** Paints the story in the colour theme picked in the toolbar, the way the app paints itself. */
const withColourTheme: Decorator = (Story, context) => {
  // Before the story renders, so its first paint is already in the theme.
  applyColourTheme(document.documentElement, String(context.globals.colours ?? DEFAULT_COLOUR_THEME))
  return <Story />
}

const preview: Preview = {
  decorators: [withColourTheme],
  globalTypes: {
    colours: {
      description: 'Colour theme',
      toolbar: {
        title: 'Colours',
        icon: 'paintbrush',
        items: COLOUR_THEMES.map((theme) => ({ value: theme.id, title: theme.name, right: theme.kind })),
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { colours: DEFAULT_COLOUR_THEME },
  parameters: {
    layout: 'padded',
    // The page is the theme's `space`, from `theme.css`; Storybook's own
    // backgrounds would paint over it.
    backgrounds: { disable: true },
    controls: { expanded: true },
  },
}
export default preview
