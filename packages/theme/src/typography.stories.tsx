// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Stack, Typography as MuiTypography, TypographyVariant } from "@mui/material";
import { StoryObj } from "@storybook/react";
import { ReactNode } from "react";

export default {
  title: "Theme/Data Display/Typography",
};

function Wrapper({ children }: { children: ReactNode }): JSX.Element {
  return <Stack sx={{ border: "1px dotted", borderColor: "info.main" }}>{children}</Stack>;
}

const variants: { variant: TypographyVariant; text: string }[] = [
  { variant: "h1", text: "h1. Heading" },
  { variant: "h2", text: "h2. Heading" },
  { variant: "h3", text: "h3. Heading" },
  { variant: "h4", text: "h4. Heading" },
  { variant: "h5", text: "h5. Heading" },
  { variant: "h6", text: "h6. Heading" },
  {
    variant: "subtitle1",
    text: "subtitle1. Lorem ipsum dolor sit amet, consectetur adipisicing elit. Quos blanditiis tenetur",
  },
  {
    variant: "subtitle2",
    text: "subtitle2. Lorem ipsum dolor sit amet, consectetur adipisicing elit. Quos blanditiis tenetur",
  },
  {
    variant: "body1",
    text: "body1. Lorem ipsum dolor sit amet, consectetur adipisicing elit. Quos blanditiis tenetur unde suscipit, quam beatae rerum inventore consectetur, neque doloribus, cupiditate numquam dignissimos laborum fugiat deleniti? Eum quasi quidem quibusdam.",
  },
  {
    variant: "body2",
    text: "body2. Lorem ipsum dolor sit amet, consectetur adipisicing elit. Quos blanditiis tenetur unde suscipit, quam beatae rerum inventore consectetur, neque doloribus, cupiditate numquam dignissimos laborum fugiat deleniti? Eum quasi quidem quibusdam.",
  },
  { variant: "button", text: "button text" },
  { variant: "caption", text: "caption text" },
  { variant: "overline", text: "overline text" },
];

export const Variants: StoryObj = {
  render: function Story() {
    return (
      <Stack gap={1} padding={1}>
        {variants.map(({ variant, text }) => (
          <Wrapper key={variant}>
            <MuiTypography variant={variant} display="block" gutterBottom>
              {text}
            </MuiTypography>
          </Wrapper>
        ))}
      </Stack>
    );
  },
  parameters: { colorScheme: "light" },
};

const fontFeatures = [
  { label: "tnum", text: "0123456789" },
  { label: "calt", text: "=> == === 1x1 2*2 3xA ++ :=" },
  // we don't currently use these ligatures but putting it in just so we never forget it exists
  { label: "cv08 / cv10", text: "显示时间戳在" },
];

export const FontFeatureSettings: StoryObj = {
  render: () => (
    <table>
      <tbody>
        {fontFeatures.map(({ label, text }) => (
          <tr key={label}>
            <th style={{ width: 100 }}>{label}</th> <td>{text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  ),
  parameters: { colorScheme: "light" },
};

export const FontFeatureSettingsChinese: StoryObj = {
  ...FontFeatureSettings,
  parameters: { forceLanguage: "zh", colorScheme: "light" },
};

export const FontFeatureSettingsJapanese: StoryObj = {
  ...FontFeatureSettings,
  parameters: { forceLanguage: "ja", colorScheme: "light" },
};
