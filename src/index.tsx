import * as React from 'react';
import * as ReactDOM from 'react-dom';

// Internally, the portalNode must be for either HTML or SVG elements
const ELEMENT_TYPE_HTML = 'html';
const ELEMENT_TYPE_SVG  = 'svg';

type BaseOptions = {
    attributes?: { [key: string]: string };
};

type HtmlOptions = BaseOptions & {
    containerElement?: keyof HTMLElementTagNameMap;
};

type SvgOptions = BaseOptions & {
    containerElement?: keyof SVGElementTagNameMap;
};

type Options = HtmlOptions | SvgOptions;

// ReactDOM can handle several different namespaces, but they're not exported publicly
// https://github.com/facebook/react/blob/b87aabdfe1b7461e7331abb3601d9e6bb27544bc/packages/react-dom/src/shared/DOMNamespaces.js#L8-L10
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

type Component<P> = React.Component<P> | React.ComponentType<P>;

type ComponentProps<C extends Component<any>> = C extends Component<infer P> ? P : never;

interface PortalNodeBase<C extends Component<any>> {
    // Used by the out portal to send props back to the real element
    // Hooked by InPortal to become a state update (and thus rerender)
    setPortalProps(p: ComponentProps<C>): void;
    // Used to track props set before the InPortal hooks setPortalProps
    getInitialPortalProps(): ComponentProps<C>;
    // Move the node from wherever it is, to this parent, replacing the placeholder
    mount(newParent: Node, placeholder: Node): void;
    // If mounted, unmount the node and put the initial placeholder back
    // If an expected placeholder is provided, only unmount if that's still that was the
    // latest placeholder we replaced. This avoids some race conditions.
    unmount(expectedPlaceholder?: Node): void;
}
export interface HtmlPortalNode<C extends Component<any> = Component<any>> extends PortalNodeBase<C> {
    element: HTMLElement;
    elementType: typeof ELEMENT_TYPE_HTML;
}
export interface SvgPortalNode<C extends Component<any> = Component<any>> extends PortalNodeBase<C> {
    element: SVGElement;
    elementType: typeof ELEMENT_TYPE_SVG;
}
type AnyPortalNode<C extends Component<any> = Component<any>> = HtmlPortalNode<C> | SvgPortalNode<C>;


const validateElementType = (domElement: Element, elementType: typeof ELEMENT_TYPE_HTML | typeof ELEMENT_TYPE_SVG) => {
    const ownerDocument = (domElement.ownerDocument ?? document) as any;
    // Cast document to `any` because Typescript doesn't know about the legacy `Document.parentWindow` field, and also
    // doesn't believe `Window.HTMLElement`/`Window.SVGElement` can be used in instanceof tests.
    const ownerWindow = ownerDocument.defaultView ?? ownerDocument.parentWindow ?? window; // `parentWindow` for IE8 and earlier

    switch (elementType) {
        case ELEMENT_TYPE_HTML:
            return domElement instanceof ownerWindow.HTMLElement;
        case ELEMENT_TYPE_SVG:
            return domElement instanceof ownerWindow.SVGElement;
        default:
            throw new Error(`Unrecognized element type "${elementType}" for validateElementType.`);
    }
};

// This is the internal implementation: the public entry points set elementType to an appropriate value
const createPortalNode = <C extends Component<any>>(
    elementType: typeof ELEMENT_TYPE_HTML | typeof ELEMENT_TYPE_SVG,
    options?: Options
): AnyPortalNode<C> => {
    let initialProps = {} as ComponentProps<C>;

    let parent: Node | undefined;
    let lastPlaceholder: Node | undefined;

    let element;

    switch (elementType) {
        case ELEMENT_TYPE_HTML:
            element = document.createElement(options?.containerElement ?? 'div');
            break;
        case ELEMENT_TYPE_SVG:
            element = document.createElementNS(SVG_NAMESPACE, options?.containerElement ?? 'g');
            break;
        default:
            throw new Error(`Invalid element type "${elementType}" for createPortalNode: must be "html" or "svg".`);
    }

    if (options && typeof options === "object" && options.attributes) {
        for (const [key, value] of Object.entries(options.attributes)) {
            element.setAttribute(key, value);
        }
    }

    const portalNode: AnyPortalNode<C> = {
        element,
        elementType,
        setPortalProps: (props: ComponentProps<C>) => {
            initialProps = props;
        },
        getInitialPortalProps: () => {
            return initialProps;
        },
        mount: (newParent: HTMLElement, newPlaceholder: HTMLElement) => {
            if (newPlaceholder === lastPlaceholder) {
                // Already mounted - noop.
                return;
            }
            portalNode.unmount();

            // To support SVG and other non-html elements, the portalNode's elementType needs to match
            // the elementType it's being rendered into
            if (newParent !== parent) {
                if (!validateElementType(newParent, elementType)) {
                    throw new Error(`Invalid element type for portal: "${elementType}" portalNodes must be used with ${elementType} elements, but OutPortal is within <${newParent.tagName}>.`);
                }
            }

            newParent.replaceChild(
                portalNode.element,
                newPlaceholder,
            );

            parent = newParent;
            lastPlaceholder = newPlaceholder;
        },
        unmount: (expectedPlaceholder?: Node) => {
            if (expectedPlaceholder && expectedPlaceholder !== lastPlaceholder) {
                // Skip unmounts for placeholders that aren't currently mounted
                // They will have been automatically unmounted already by a subsequent mount()
                return;
            }

            if (parent && lastPlaceholder) {
                parent.replaceChild(
                    lastPlaceholder,
                    portalNode.element,
                );

                parent = undefined;
                lastPlaceholder = undefined;
            }
        }
    } as AnyPortalNode<C>;

    return portalNode;
};

interface InPortalProps {
    node: AnyPortalNode;
    children: React.ReactNode;
}

function InPortal({ children, node }: InPortalProps) {
    const [nodeProps, setNodeProps] = React.useState(node.getInitialPortalProps());
    React.useLayoutEffect(() => {
        Object.assign(node, {
            setPortalProps: (props: {}) => {
                // Rerender the child node here if/when the out portal props change
                setNodeProps(props);
            }
        });
    }, [node]);
    return ReactDOM.createPortal(
        React.Children.map(children, (child) => {
            if (!React.isValidElement(child)) return child;
            return React.cloneElement(child, nodeProps)
        }),
        node.element
    );
}

type OutPortalProps<C extends Component<any>> = {
    node: AnyPortalNode<C>
} & Partial<ComponentProps<C>>;

function OutPortal<C extends Component<any>>({ node, ...propsToPass }: OutPortalProps<C>) {
    // Render a placeholder to the DOM, so we can get a reference into
    // our location in the DOM, and swap it out for the portaled node.
    const placeholderRef = React.useRef<HTMLElement>(null!)
    // SVG tagName is lowercase and case sensitive, HTML is uppercase and case insensitive.
    // React.createElement expects lowercase first letter to treat as non-component element.
    // (Passing uppercase type won't break anything, but React warns otherwise:)
    // https://github.com/facebook/react/blob/8039f1b2a05d00437cd29707761aeae098c80adc/CHANGELOG.md?plain=1#L1984
    const placeholderType = node.elementType === ELEMENT_TYPE_HTML
        ? node.element.tagName.toLowerCase()
        : node.element.tagName;
    // Using layout effect to get proper placeholder ref on first render.
    React.useLayoutEffect(() => {
        const placeholder = placeholderRef.current;
        node.mount(placeholder.parentNode!, placeholder);
        node.setPortalProps(propsToPass as ComponentProps<C>);
        return () => {
            node.unmount(placeholder);
            node.setPortalProps({} as ComponentProps<C>);
        };
    }, [node]);
    return React.createElement(placeholderType, {
        ref: placeholderRef
    });
}

const createHtmlPortalNode = createPortalNode.bind(null, ELEMENT_TYPE_HTML) as
    <C extends Component<any> = Component<any>>(options?: HtmlOptions) => HtmlPortalNode<C>;
const createSvgPortalNode  = createPortalNode.bind(null, ELEMENT_TYPE_SVG) as
    <C extends Component<any> = Component<any>>(options?: SvgOptions) => SvgPortalNode<C>;

export {
    createHtmlPortalNode,
    createSvgPortalNode,
    InPortal,
    OutPortal,
}
