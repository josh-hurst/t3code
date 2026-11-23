import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import {
  Combobox,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "./combobox";
import { Command, CommandInput, CommandItem, CommandList } from "./command";
import { Menu, MenuItem, MenuPopup, MenuSearchInput, MenuTrigger } from "./menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./select";

const ITEMS = ["Alpha", "Beta", "Gamma"] as const;

it("navigates Combobox options with Ctrl+N and Ctrl+P", async () => {
  const onSelect = vi.fn();
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <Combobox
        items={ITEMS}
        autoHighlight
        open={open}
        onOpenChange={setOpen}
        value={null}
        onValueChange={(value) => {
          if (value) onSelect(value);
          setOpen(false);
        }}
      >
        <ComboboxTrigger aria-label="Pick item">Pick item</ComboboxTrigger>
        <ComboboxPopup>
          <ComboboxSearchInput aria-label="Search items" />
          <ComboboxList>
            {(item: string) => (
              <ComboboxItem key={item} value={item}>
                {item}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    );
  }

  await using screen = await render(<Harness />, {
    router: false /* primitive widget test does not involve routing */,
  });
  await userEvent.click(screen.getByRole("combobox", { name: "Pick item" }));
  await expect.element(page.getByRole("combobox", { name: "Search items" })).toHaveFocus();

  // First Ctrl+N highlights Alpha (index 0), second moves to Beta, third to Gamma, Ctrl+P back to Beta.
  await userEvent.keyboard("{Control>}n{/Control}");
  await userEvent.keyboard("{Control>}n{/Control}");
  await userEvent.keyboard("{Control>}n{/Control}");
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.keyboard("{Enter}");
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("Beta");
});

it("navigates Command / Autocomplete items with Ctrl+N and Ctrl+P", async () => {
  const onSelect = vi.fn();
  await using _screen = await render(
    <Command items={ITEMS}>
      <CommandInput aria-label="Search commands" />
      <CommandList>
        {(item: string) => (
          <CommandItem key={item} value={item} onClick={() => onSelect(item)}>
            {item}
          </CommandItem>
        )}
      </CommandList>
    </Command>,
    { router: false /* primitive widget test does not involve routing */ },
  );

  const input = page.getByRole("combobox", { name: "Search commands" });
  await expect.element(input).toHaveFocus();
  await userEvent.keyboard("{Control>}n{/Control}");
  await userEvent.keyboard("{Control>}n{/Control}");
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.keyboard("{Enter}");
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("Beta");
});

it("navigates Menu items (including from MenuSearchInput) with Ctrl+N and Ctrl+P", async () => {
  const onSelect = vi.fn();
  await using screen = await render(
    <Menu>
      <MenuTrigger>Open menu</MenuTrigger>
      <MenuPopup>
        <MenuSearchInput aria-label="Filter menu" autoFocus />
        {ITEMS.map((item) => (
          <MenuItem key={item} onClick={() => onSelect(item)}>
            {item}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>,
    { router: false /* primitive widget test does not involve routing */ },
  );

  await userEvent.click(screen.getByRole("button", { name: "Open menu" }));
  await expect.element(page.getByRole("textbox", { name: "Filter menu" })).toHaveFocus();
  await userEvent.keyboard("{Control>}n{/Control}");
  await userEvent.keyboard("{Control>}n{/Control}");
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.keyboard("{Enter}");
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("Alpha");
});

it("navigates Select options with Ctrl+N and Ctrl+P", async () => {
  const onChange = vi.fn();
  await using screen = await render(
    <Select defaultValue="Alpha" onValueChange={(value) => onChange(value)}>
      <SelectTrigger aria-label="Choose option">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {ITEMS.map((item) => (
          <SelectItem key={item} value={item}>
            {item}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>,
    { router: false /* primitive widget test does not involve routing */ },
  );

  await userEvent.click(screen.getByRole("combobox", { name: "Choose option" }));
  await expect.element(page.getByRole("option", { name: "Beta" })).toBeVisible();
  await userEvent.keyboard("{Control>}n{/Control}");
  await userEvent.keyboard("{Control>}n{/Control}");
  await userEvent.keyboard("{Control>}n{/Control}");
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.keyboard("{Enter}");
  expect(onChange).toHaveBeenCalledWith("Beta");
});
