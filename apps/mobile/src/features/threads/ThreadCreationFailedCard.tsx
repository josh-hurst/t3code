import { GROUP_CARD_CLASS_NAME } from "../../lib/surfaces";
import { cn } from "../../lib/cn";
import { Button } from "../../components/ui/Button";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

export function ThreadCreationFailedCard(props: {
  readonly reason: string;
  readonly onEditTask: () => void;
}) {
  return (
    <View className={cn(GROUP_CARD_CLASS_NAME, "gap-2.5 p-4")}>
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-danger-foreground">
        Could not start task
      </Text>
      <Text className="font-sans text-sm leading-normal text-foreground-secondary">
        {props.reason}
      </Text>
      <Text className="font-sans text-xs leading-normal text-foreground-secondary">
        Your prompt was kept in the project draft.
      </Text>
      <View className="flex-row">
        <Button label="Edit task" tone="primary" onPress={props.onEditTask} />
      </View>
    </View>
  );
}
