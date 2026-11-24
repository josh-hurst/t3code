import {
  htmlRenderComposeAppendText,
  readHtmlRenderComposeRequest,
} from "@t3tools/shared/htmlRender";

export function readActivatedHtmlRenderCompose(input: {
  readonly data: unknown;
  readonly frameFocused: boolean;
  readonly userActivationActive: boolean;
}): string | undefined {
  if (!input.frameFocused || !input.userActivationActive) return undefined;
  return readHtmlRenderComposeRequest(input.data)?.text;
}

export function applyHtmlRenderComposeToComposer(input: {
  readonly composer: {
    readonly getSendContext: () => {
      readonly answeringPendingUserInput: boolean;
      readonly prompt: string;
    };
    readonly insertTextAtEnd: (text: string) => boolean;
  } | null;
  readonly text: string;
  readonly scheduleFocus: () => void;
}): boolean {
  const { composer } = input;
  if (!composer) return false;
  const { answeringPendingUserInput, prompt } = composer.getSendContext();
  if (answeringPendingUserInput) return false;
  if (!composer.insertTextAtEnd(htmlRenderComposeAppendText(prompt, input.text))) return false;
  input.scheduleFocus();
  return true;
}
