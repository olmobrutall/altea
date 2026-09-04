// The OOXML element tree — now just altea core's generic XML tree under its OOXML names.
//
// It was written here first (altea's stand-in for `DocumentFormat.OpenXml.OpenXmlElement`, since there is no
// OpenXML SDK for TypeScript) and MOVED to `@altea/altea/server/xml/xmlElement` when @altea/altea-workflow
// needed the same tree for BPMN diagrams — the role `System.Xml.Linq` plays for Signum, which uses XElement
// in both modules. Nothing about it was OOXML-specific except the names, so this file keeps the `Oxml*`
// aliases and the rest of the package reads unchanged.

export {
    XmlNode as OxmlNode,
    XmlText as OxmlText,
    XmlComment as OxmlComment,
    XmlCData as OxmlCData,
    XmlElement as OxmlElement,
    XmlTextWriter,
    SpaceProcessingModeValues,
    type SpaceProcessingMode,
} from "@altea/altea/server/xml/xmlElement";
