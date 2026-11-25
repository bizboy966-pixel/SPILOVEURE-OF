import React from "react";
import { ScrollView, type ScrollViewProps } from "react-native";

type Props = ScrollViewProps & { bottomOffset?: number };

export const KeyboardAwareScrollView = React.forwardRef<ScrollView, Props>(
  ({ bottomOffset: _bottomOffset, ...props }, ref) => <ScrollView ref={ref} {...props} />,
);
KeyboardAwareScrollView.displayName = "KeyboardAwareScrollView";
